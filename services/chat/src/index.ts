// ZapaKid chat Worker (chat.zapakid.ro): conversations and sealed envelopes. It only ever sees ciphertext and
// routing metadata; it can never decrypt a chat.
import { authenticate, type Caller } from "./auth";
import { readJson } from "./body";
import { handleCreate, handleDelete, handleGet, handleList } from "./conversations";
import type { Env } from "./env";
import { handleHealth } from "./health";
import { error, HttpError, isLoopback, json } from "./http";
import { consume, purgeProcessedEvents } from "./membership";
import { noRooms, type Rooms } from "./rooms";

// The live side of conversations (Durable Objects) arrives with messages; until then nothing is live.
function rooms(_env: Env): Rooms {
  return noRooms;
}

type Authed = (request: Request, env: Env, caller: Caller, params: string[]) => Promise<Response>;

// Method + path pattern → handler. Every route except /health needs a chat token.
const ROUTES: { method: string; pattern: RegExp; handler: Authed }[] = [
  { method: "POST", pattern: /^\/v1\/conversations$/, handler: (r, env, c) => handleCreate(r, env, c) },
  { method: "GET", pattern: /^\/v1\/conversations$/, handler: (r, env, c) => handleList(r, env, c) },
  {
    method: "GET",
    pattern: /^\/v1\/conversations\/([^/]+)$/,
    handler: (_r, env, c, [id]) => handleGet(env, c, id ?? ""),
  },
  {
    method: "DELETE",
    pattern: /^\/v1\/conversations\/([^/]+)$/,
    handler: (_r, env, c, [id]) => handleDelete(env, rooms(env), c, id ?? ""),
  },
];

// Local tests only: puts membership events on the local queue so the real consumer applies them.
async function e2eMembership(request: Request, env: Env): Promise<Response> {
  if (env.E2E_HOOKS !== "on" || !env.MEMBERSHIP_E2E || !isLoopback(new URL(request.url))) {
    return error(404, "not_found", "No such endpoint.");
  }
  const body = await readJson(request, 256 * 1024);
  const events = Array.isArray(body.events) ? body.events : [];
  await env.MEMBERSHIP_E2E.sendBatch(events.map((e: unknown) => ({ body: e })));
  return json({ queued: events.length }, 202);
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    if (request.method !== "GET") return error(405, "method_not_allowed", "Use GET.", { allow: "GET" });
    return handleHealth(request, env);
  }
  if (url.pathname === "/__e2e/membership" && request.method === "POST") return e2eMembership(request, env);
  const matches = ROUTES.filter((r) => r.pattern.test(url.pathname));
  if (matches.length === 0) return error(404, "not_found", "No such endpoint.");
  const match = matches.find((r) => r.method === request.method);
  if (!match) {
    const allow = matches.map((r) => r.method).join(", ");
    return error(405, "method_not_allowed", `Use ${allow}.`, { allow });
  }
  const caller = await authenticate(request, env);
  const params = (match.pattern.exec(url.pathname) ?? []).slice(1).map((p) => decodeURIComponent(p));
  return match.handler(request, env, caller, params);
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (e) {
      if (e instanceof HttpError) return e.response();
      // Never log request bodies or headers: they carry tokens and ciphertext.
      console.error(JSON.stringify({ msg: "unhandled", path: new URL(request.url).pathname, err: String(e) }));
      return error(500, "server_error", "Something went wrong.");
    }
  },

  async queue(batch, env, _ctx): Promise<void> {
    await consume(batch, env, rooms(env));
  },

  async scheduled(_controller, env): Promise<void> {
    await purgeProcessedEvents(env);
  },
} satisfies ExportedHandler<Env>;
