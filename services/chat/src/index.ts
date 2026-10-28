// ZapaKid chat Worker (chat.zapakid.ro): conversations and sealed envelopes. It only ever sees ciphertext and
// routing metadata; it can never decrypt a chat.
import {
  handleDownload,
  handleGetAttachment,
  handleReserve,
  handleUpload,
  purgeAbandonedAttachments,
} from "./attachments";
import { authenticate, type Caller } from "./auth";
import { readJson } from "./body";
import { handleContacts, handleCreate, handleDelete, handleGet, handleList } from "./conversations";
import type { Env } from "./env";
import { handleHealth } from "./health";
import { error, HttpError, isLoopback, json } from "./http";
import { consume, purgeProcessedEvents } from "./membership";
import { handleAck, handleFetch, handleSend, handleStream } from "./messages";
import { durableRooms } from "./room";

export { ConversationRoom } from "./room";
// Workers RPC for the calls service (its CHAT service binding); not reachable over HTTP.
export { ChatMembership } from "./rpc";

const rooms = durableRooms;

type Authed = (
  request: Request,
  env: Env,
  caller: Caller,
  params: string[],
  ctx: ExecutionContext,
) => Promise<Response>;

// Method + path pattern → handler. Every route except /health needs a chat token.
const ROUTES: { method: string; pattern: RegExp; handler: Authed }[] = [
  { method: "POST", pattern: /^\/v1\/conversations$/, handler: (r, env, c) => handleCreate(r, env, c) },
  { method: "GET", pattern: /^\/v1\/conversations$/, handler: (r, env, c) => handleList(r, env, c) },
  { method: "GET", pattern: /^\/v1\/contacts$/, handler: (_r, env, c) => handleContacts(env, c) },
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
  { method: "POST", pattern: /^\/v1\/attachments$/, handler: (r, env, c) => handleReserve(r, env, c) },
  {
    method: "GET",
    pattern: /^\/v1\/attachments\/([^/]+)$/,
    handler: (r, env, c, [id]) => handleGetAttachment(r, env, c, id ?? ""),
  },
  {
    method: "POST",
    pattern: /^\/v1\/conversations\/([^/]+)\/messages$/,
    handler: (r, env, c, [id], ctx) => handleSend(r, env, ctx, c, id ?? ""),
  },
  {
    method: "GET",
    pattern: /^\/v1\/conversations\/([^/]+)\/messages$/,
    handler: (r, env, c, [id]) => handleFetch(r, env, c, id ?? ""),
  },
  {
    method: "POST",
    pattern: /^\/v1\/conversations\/([^/]+)\/acks$/,
    handler: (r, env, c, [id]) => handleAck(r, env, c, id ?? ""),
  },
  {
    method: "GET",
    pattern: /^\/v1\/conversations\/([^/]+)\/stream$/,
    handler: (r, env, c, [id]) => handleStream(r, env, c, id ?? ""),
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

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    if (request.method !== "GET") return error(405, "method_not_allowed", "Use GET.", { allow: "GET" });
    return handleHealth(request, env);
  }
  if (url.pathname === "/__e2e/membership" && request.method === "POST") return e2eMembership(request, env);
  // One-time URLs: the token in the URL is the authorization, no chat token.
  const oneTime = /^\/v1\/attachments\/([^/]+)\/(upload|download)$/.exec(url.pathname);
  if (oneTime) {
    const [, id = "", kind] = oneTime;
    const method = kind === "upload" ? "PUT" : "GET";
    if (request.method !== method) return error(405, "method_not_allowed", `Use ${method}.`, { allow: method });
    return kind === "upload" ? handleUpload(request, env, id) : handleDownload(request, env, id);
  }
  const matches = ROUTES.filter((r) => r.pattern.test(url.pathname));
  if (matches.length === 0) return error(404, "not_found", "No such endpoint.");
  const match = matches.find((r) => r.method === request.method);
  if (!match) {
    const allow = matches.map((r) => r.method).join(", ");
    return error(405, "method_not_allowed", `Use ${allow}.`, { allow });
  }
  const caller = await authenticate(request, env);
  const params = (match.pattern.exec(url.pathname) ?? []).slice(1).map((p) => decodeURIComponent(p));
  return match.handler(request, env, caller, params, ctx);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await route(request, env, ctx);
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
    await purgeAbandonedAttachments(env);
  },
} satisfies ExportedHandler<Env>;
