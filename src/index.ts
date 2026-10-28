// ZapaKid API Worker. The server only ever sees public keys and ciphertext; it can never decrypt a chat.
import { handleAppleAttestation, handleChallenge } from "./app-attest";
import { handleAppleWebCallback, handleAppleWebExchange, handleAppleWebStart } from "./apple-web";
import { BadRequest } from "./body";
import { handleChatToken, handleJwks } from "./chat-token";
import { handleCountPreKeys, handleGetIdentity, handleRegisterDevice, handleRemoveDevice } from "./devices";
import { handleHealth } from "./health";
import type { Env } from "./env";
import { routeFamilies } from "./families";
import { error } from "./http";
import { purgeExpired } from "./purge";
import { limitAuth } from "./rate-limit";
import { handleLogout, handleLogoutAll, handleMe, handleNonce, handleSignIn } from "./routes";

type Handler = (request: Request, env: Env) => Response | Promise<Response>;

// `limited`: counted against AUTH_LIMITER before anything else is done (unauthenticated endpoints).
const ROUTES: Record<string, { method: string; handler: Handler; limited?: true }> = {
  "/health": { method: "GET", handler: handleHealth },
  "/v1/auth/nonce": { method: "POST", handler: handleNonce, limited: true },
  "/v1/attestation/challenge": { method: "POST", handler: handleChallenge, limited: true },
  "/v1/attestation/apple": { method: "POST", handler: handleAppleAttestation, limited: true },
  "/v1/auth/apple": { method: "POST", handler: (request, env) => handleSignIn(request, env, "apple"), limited: true },
  "/v1/auth/apple/web": { method: "POST", handler: handleAppleWebStart, limited: true },
  "/v1/auth/apple/callback": { method: "POST", handler: handleAppleWebCallback, limited: true },
  "/v1/auth/apple/exchange": { method: "POST", handler: handleAppleWebExchange, limited: true },
  "/v1/auth/google": {
    method: "POST",
    handler: (request, env) => handleSignIn(request, env, "google"),
    limited: true,
  },
  "/v1/auth/logout": { method: "POST", handler: handleLogout },
  "/v1/auth/logout-all": { method: "POST", handler: handleLogoutAll },
  "/v1/me": { method: "GET", handler: handleMe },
  "/v1/devices": { method: "POST", handler: handleRegisterDevice, limited: true },
  "/v1/keys/prekeys": { method: "GET", handler: handleCountPreKeys },
  "/v1/chat/token": { method: "POST", handler: handleChatToken },
  "/.well-known/jwks.json": { method: "GET", handler: handleJwks },
};

// Paths with one parameter: the pattern's group is passed to the handler.
const PATTERN_ROUTES: {
  pattern: RegExp;
  method: string;
  handler: (r: Request, e: Env, p: string) => Promise<Response>;
}[] = [
  { pattern: /^\/v1\/devices\/([^/]+)$/, method: "DELETE", handler: handleRemoveDevice },
  { pattern: /^\/v1\/accounts\/([^/]+)\/identity$/, method: "GET", handler: handleGetIdentity },
];

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : undefined;
      if (!route) {
        for (const p of PATTERN_ROUTES) {
          const match = p.pattern.exec(url.pathname);
          if (!match) continue;
          if (request.method !== p.method) {
            return error(405, "method_not_allowed", `Use ${p.method}.`, { allow: p.method });
          }
          return await p.handler(request, env, decodeURIComponent(match[1] ?? ""));
        }
        return (await routeFamilies(request, env, url.pathname)) ?? error(404, "not_found", "No such endpoint.");
      }
      if (request.method !== route.method) {
        return error(405, "method_not_allowed", `Use ${route.method}.`, { allow: route.method });
      }
      if (route.limited) {
        const limited = await limitAuth(request, env);
        if (limited) return limited;
      }
      return await route.handler(request, env);
    } catch (e) {
      if (e instanceof BadRequest) return error(e.status, e.code, e.message);
      // Never log request bodies or headers: they carry sign-in and session tokens.
      console.error(JSON.stringify({ msg: "unhandled", path: url.pathname, err: String(e) }));
      return error(500, "server_error", "Something went wrong.");
    }
  },

  async scheduled(_controller, env): Promise<void> {
    await purgeExpired(env);
  },
} satisfies ExportedHandler<Env>;

export { BadRequest };
