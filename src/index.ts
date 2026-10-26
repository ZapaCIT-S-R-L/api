// ZapaKid API Worker. The server only ever sees public keys and ciphertext; it can never decrypt a chat.
import { BadRequest } from "./body";
import type { Env } from "./env";
import { error, json } from "./http";
import { handleLogout, handleMe, handleNonce, handleSignIn } from "./routes";

type Handler = (request: Request, env: Env) => Response | Promise<Response>;

const ROUTES: Record<string, { method: string; handler: Handler }> = {
  "/health": { method: "GET", handler: (_request, env) => json({ status: "ok", version: env.VERSION }) },
  "/v1/auth/nonce": { method: "POST", handler: handleNonce },
  "/v1/auth/apple": { method: "POST", handler: (request, env) => handleSignIn(request, env, "apple") },
  "/v1/auth/google": { method: "POST", handler: (request, env) => handleSignIn(request, env, "google") },
  "/v1/auth/logout": { method: "POST", handler: handleLogout },
  "/v1/me": { method: "GET", handler: handleMe },
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : undefined;
      if (!route) return error(404, "not_found", "No such endpoint.");
      if (request.method !== route.method) {
        return error(405, "method_not_allowed", `Use ${route.method}.`, { allow: route.method });
      }
      return await route.handler(request, env);
    } catch (e) {
      if (e instanceof BadRequest) return error(e.status, e.code, e.message);
      // Never log request bodies or headers: they carry sign-in and session tokens.
      console.error(JSON.stringify({ msg: "unhandled", path: url.pathname, err: String(e) }));
      return error(500, "server_error", "Something went wrong.");
    }
  },
} satisfies ExportedHandler<Env>;
