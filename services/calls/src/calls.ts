// The calls API (openapi.yaml): start, join, leave, decline, the call log, the events WebSocket and the Realtime
// proxy. Every request carries a chat token (src/auth.ts); the call's Durable Object (src/call-room.ts) decides who
// may see and change the call.
import { authenticate, InvalidToken, type Caller } from "./auth";
import { BadRequest, id, invalid, onlyFields, readJson } from "./body";
import type { CallView, Result } from "./call-room";
import { ChatOutdated, ChatUnavailable, membership, revoked, ringTargets } from "./chat";
import type { Env } from "./env";
import { empty, error, json } from "./http";
import { KeysUnavailable } from "./jwks";
import { limits } from "./limits";
import { pushProvider } from "./push";
import { iceServers, RealtimeRejected, RealtimeUnavailable, sfu } from "./realtime";

const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TRACK_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MID = /^#?[A-Za-z0-9_-]{1,64}$/;
const MAX_SDP = 60_000;
const MAX_TRACKS = 16;
const LOG_LIMIT = 50;

type Handler = (ctx: Context) => Promise<Response>;

interface Context {
  request: Request;
  env: Env;
  who: Caller;
  callId: string;
  sessionId: string;
}

interface Route {
  pattern: RegExp;
  methods: Record<string, Handler>;
}

const ROUTES: Route[] = [
  { pattern: /^\/v1\/calls$/, methods: { POST: create, GET: list } },
  { pattern: /^\/v1\/calls\/([^/]+)$/, methods: { GET: (c) => answer(room(c).snapshot(c.who)) } },
  { pattern: /^\/v1\/calls\/([^/]+)\/join$/, methods: { POST: join } },
  { pattern: /^\/v1\/calls\/([^/]+)\/leave$/, methods: { POST: (c) => answer(room(c).leave(c.who), 204) } },
  { pattern: /^\/v1\/calls\/([^/]+)\/decline$/, methods: { POST: (c) => answer(room(c).decline(c.who), 204) } },
  { pattern: /^\/v1\/calls\/([^/]+)\/events$/, methods: { GET: events } },
  { pattern: /^\/v1\/calls\/([^/]+)\/sessions$/, methods: { POST: newSession } },
  { pattern: /^\/v1\/calls\/([^/]+)\/sessions\/([^/]+)\/tracks\/new$/, methods: { POST: newTracks } },
  { pattern: /^\/v1\/calls\/([^/]+)\/sessions\/([^/]+)\/renegotiate$/, methods: { PUT: renegotiate } },
  { pattern: /^\/v1\/calls\/([^/]+)\/sessions\/([^/]+)\/tracks\/close$/, methods: { PUT: closeTracks } },
];

const notFound = () => error(404, "not_found", "No such call.");

// The response for a /v1/calls path, or null if the path is not one of them.
export async function routeCalls(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  for (const route of ROUTES) {
    const match = route.pattern.exec(path);
    if (!match) continue;
    const handler = route.methods[request.method];
    if (!handler) {
      const allow = Object.keys(route.methods).join(", ");
      return error(405, "method_not_allowed", `Use ${allow}.`, { allow });
    }
    let who: Caller;
    try {
      who = await authenticate(request, env);
    } catch (e) {
      if (e instanceof InvalidToken) {
        console.log(JSON.stringify({ msg: "token rejected", reason: e.message }));
        return error(401, "invalid_token", "Send a valid chat token: Authorization: Bearer <token>.", {
          "www-authenticate": "Bearer",
        });
      }
      if (e instanceof KeysUnavailable) {
        console.error(JSON.stringify({ msg: "account keys unavailable", err: e.message }));
        return error(503, "keys_unavailable", "Calls are unavailable right now. Try again later.");
      }
      throw e;
    }
    // Signed out everywhere (api #81) or the device removed (api #92) since the token was issued: refused like an
    // invalid token.
    try {
      if (await revoked(env, who)) {
        console.log(JSON.stringify({ msg: "token rejected", reason: "revoked" }));
        return error(
          401,
          "invalid_token",
          "This chat token was revoked (signed out, or this device was removed). Sign in again.",
          {
            "www-authenticate": "Bearer",
          },
        );
      }
    } catch (e) {
      if (e instanceof ChatUnavailable) return chatUnavailable(e);
      throw e;
    }
    const callId = match[1] ?? "";
    const sessionId = match[2] ?? "";
    if (match[1] !== undefined && !CALL_ID.test(callId)) return notFound();
    if (match[2] !== undefined && !SESSION_ID.test(sessionId)) return notFound();
    try {
      return await handler({ request, env, who, callId, sessionId });
    } catch (e) {
      if (e instanceof BadRequest) return error(e.status, e.code, e.message);
      if (e instanceof ChatUnavailable) return chatUnavailable(e);
      if (e instanceof RealtimeRejected) return error(400, "realtime_rejected", `Realtime refused: ${e.message}`);
      if (e instanceof RealtimeUnavailable) {
        console.error(JSON.stringify({ msg: "realtime unavailable", err: e.message }));
        return error(502, "realtime_unavailable", "Calls are unavailable right now. Try again later.");
      }
      throw e;
    }
  }
  return null;
}

function room(c: { env: Env; callId: string }) {
  return c.env.CALL.get(c.env.CALL.idFromName(c.callId));
}

async function answer<T>(pending: Promise<Result<T>>, status = 200): Promise<Response> {
  const result = await pending;
  if (!result.ok) return error(result.status, result.code, result.message);
  return status === 204 ? empty(204) : json(result.value, status);
}

const rateLimited = () => error(429, "rate_limited", "Too many calls. Try again in a minute.", { "retry-after": "60" });

export function chatUnavailable(e: Error): Response {
  if (e instanceof ChatOutdated) {
    console.error(JSON.stringify({ msg: "chat outdated", err: e.message }));
    return error(503, "chat_unavailable", "Calls are unavailable right now. Try again later.", { "retry-after": "30" });
  }
  console.error(JSON.stringify({ msg: "chat unavailable", err: e.message }));
  return error(503, "chat_unavailable", "Calls are unavailable right now. Try again later.");
}

const notAllowed = () => error(403, "conversation_not_allowed", "You are not a member of that conversation.");

async function create(c: Context): Promise<Response> {
  const body = await readJson(c.request);
  onlyFields(body, ["conversationId"], "the body");
  const conversationId = id(body.conversationId, "conversationId");
  const members = await membership(c.env, conversationId, c.who.accountId);
  if (!members.member) return notAllowed();
  if (!(await c.env.CREATE_LIMITER.limit({ key: c.who.accountId })).success) return rateLimited();
  const l = limits(c.env);

  const since = new Date(Date.now() - l.maxCallSeconds * 1000).toISOString();
  const running = await c.env.DB.prepare(
    "SELECT id FROM calls WHERE conversation_id = ? AND ended_at IS NULL AND created_at > ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(conversationId, since)
    .first<{ id: string }>();
  if (running) {
    const current = await room({ env: c.env, callId: running.id }).snapshot(c.who);
    if (current.ok && current.value.state !== "ended") {
      return json(
        {
          error: { code: "call_in_progress", message: "A call is already running in this conversation: join it." },
          callId: running.id,
        },
        409,
      );
    }
  }

  const callId = crypto.randomUUID();
  const to = ringTargets(members.members, c.who.accountId);
  const started = await room({ env: c.env, callId }).start(callId, conversationId, c.who, to);
  if (!started.ok) return error(started.status, started.code, started.message);
  const [servers] = await Promise.all([
    iceServers(c.env, l.turnTtlSeconds),
    pushProvider().ring({ callId, conversationId, from: c.who.accountId, to }),
  ]);
  return json(
    {
      call: started.value,
      iceServers: servers,
      limits: {
        maxParticipants: l.maxParticipants,
        ringTimeoutSeconds: l.ringTimeoutSeconds,
        maxDurationSeconds: l.maxCallSeconds,
      },
    },
    201,
  );
}

async function join(c: Context): Promise<Response> {
  if (!(await c.env.JOIN_LIMITER.limit({ key: c.who.accountId })).success) return rateLimited();
  const joined = await room(c).join(c.who);
  if (!joined.ok) return error(joined.status, joined.code, joined.message);
  const servers = await iceServers(c.env, limits(c.env).turnTtlSeconds);
  return json({ call: joined.value satisfies CallView, iceServers: servers });
}

async function list(c: Context): Promise<Response> {
  const conversationId = new URL(c.request.url).searchParams.get("conversationId");
  if (conversationId === null) throw invalid("conversationId is required.");
  // Observers (a kid's parents, api #73) see the log ("Alex called Maria, 12 min"), never the audio.
  const who = await membership(c.env, id(conversationId, "conversationId"), c.who.accountId);
  if (!who.member && !who.observer) return notAllowed();
  const { results } = await c.env.DB.prepare(
    `SELECT id, created_at, created_by_account, created_by_device, answered_at, ended_at, end_reason, peak_participants
     FROM calls WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  )
    .bind(conversationId, LOG_LIMIT)
    .all<{
      id: string;
      created_at: string;
      created_by_account: string;
      created_by_device: number;
      answered_at: string | null;
      ended_at: string | null;
      end_reason: string | null;
      peak_participants: number;
    }>();
  return json({
    calls: results.map((r) => ({
      callId: r.id,
      createdAt: r.created_at,
      createdBy: { accountId: r.created_by_account, deviceId: r.created_by_device },
      answeredAt: r.answered_at,
      endedAt: r.ended_at,
      endReason: r.end_reason,
      peakParticipants: r.peak_participants,
    })),
  });
}

async function events(c: Context): Promise<Response> {
  if (c.request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return error(426, "upgrade_required", "Open this as a WebSocket.", { upgrade: "websocket" });
  }
  // A fresh request: only the verified caller goes to the Durable Object, nothing the phone sent.
  return room(c).fetch(
    new Request("https://call/events", {
      headers: { upgrade: "websocket", "x-zapakid-caller": JSON.stringify(c.who) },
    }),
  );
}

// ---- Realtime proxy ----

interface SessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

function sessionDescription(value: unknown, field = "sessionDescription"): SessionDescription {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${field} must be an object.`);
  const d = value as Record<string, unknown>;
  onlyFields(d, ["type", "sdp"], field);
  if (d.type !== "offer" && d.type !== "answer") throw invalid(`${field}.type must be offer or answer.`);
  if (typeof d.sdp !== "string" || d.sdp.length === 0 || d.sdp.length > MAX_SDP) {
    throw invalid(`${field}.sdp must be 1-${MAX_SDP} characters.`);
  }
  return { type: d.type, sdp: d.sdp };
}

function optionalDescription(body: Record<string, unknown>): { sessionDescription?: SessionDescription } {
  return body.sessionDescription === undefined
    ? {}
    : { sessionDescription: sessionDescription(body.sessionDescription) };
}

async function newSession(c: Context): Promise<Response> {
  const body = await readJson(c.request, true);
  onlyFields(body, ["sessionDescription"], "the body");
  const description = optionalDescription(body);
  const allowed = await room(c).requireParticipant(c.who);
  if (!allowed.ok) return error(allowed.status, allowed.code, allowed.message);
  const created = (await sfu(
    c.env,
    "POST",
    "/sessions/new",
    description.sessionDescription ? description : undefined,
  )) as { sessionId?: unknown; sessionDescription?: unknown };
  if (typeof created.sessionId !== "string" || !SESSION_ID.test(created.sessionId)) {
    throw new RealtimeUnavailable("Realtime gave no session id");
  }
  const attached = await room(c).attachSession(c.who, created.sessionId);
  if (!attached.ok) return error(attached.status, attached.code, attached.message);
  return json(
    {
      sessionId: created.sessionId,
      ...(created.sessionDescription === undefined ? {} : { sessionDescription: created.sessionDescription }),
    },
    201,
  );
}

interface Track {
  location: "local" | "remote";
  trackName: string;
  mid?: string;
  sessionId?: string;
  kind?: "audio" | "video";
  bidirectionalMediaStream?: boolean;
}

function tracks(value: unknown): Track[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TRACKS) {
    throw invalid(`tracks must be a list of 1 to ${MAX_TRACKS}.`);
  }
  const out = (value as unknown[]).map((raw, i): Track => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid(`tracks[${i}] must be an object.`);
    const t = raw as Record<string, unknown>;
    onlyFields(t, ["location", "trackName", "mid", "sessionId", "kind", "bidirectionalMediaStream"], `tracks[${i}]`);
    if (t.location !== "local" && t.location !== "remote")
      throw invalid(`tracks[${i}].location must be local or remote.`);
    if (typeof t.trackName !== "string" || !TRACK_NAME.test(t.trackName)) {
      throw invalid(`tracks[${i}].trackName must be 1-64 letters, digits, _ or -.`);
    }
    const track: Track = { location: t.location, trackName: t.trackName };
    if (t.mid !== undefined) {
      if (typeof t.mid !== "string" || !MID.test(t.mid)) throw invalid(`tracks[${i}].mid is not valid.`);
      track.mid = t.mid;
    }
    if (t.location === "remote") {
      if (typeof t.sessionId !== "string" || !SESSION_ID.test(t.sessionId)) {
        throw invalid(`tracks[${i}].sessionId (the publisher's session) is required for a remote track.`);
      }
      track.sessionId = t.sessionId;
    } else if (t.sessionId !== undefined) {
      throw invalid(`tracks[${i}].sessionId is only for remote tracks.`);
    }
    if (t.kind !== undefined) {
      if (t.kind !== "audio" && t.kind !== "video") throw invalid(`tracks[${i}].kind must be audio or video.`);
      track.kind = t.kind;
    }
    if (t.bidirectionalMediaStream !== undefined) {
      if (typeof t.bidirectionalMediaStream !== "boolean")
        throw invalid(`tracks[${i}].bidirectionalMediaStream is a boolean.`);
      track.bidirectionalMediaStream = t.bidirectionalMediaStream;
    }
    return track;
  });
  if (new Set(out.map((t) => t.location)).size > 1) throw invalid("All tracks in one request are local or all remote.");
  return out;
}

async function newTracks(c: Context): Promise<Response> {
  const body = await readJson(c.request);
  onlyFields(body, ["sessionDescription", "tracks"], "the body");
  const list = tracks(body.tracks);
  const description = optionalDescription(body);
  const remote = list.flatMap((t) => (t.sessionId ? [{ sessionId: t.sessionId, trackName: t.trackName }] : []));
  const allowed = await room(c).authorizeSession(c.who, c.sessionId, remote);
  if (!allowed.ok) return error(allowed.status, allowed.code, allowed.message);
  const result = (await sfu(c.env, "POST", `/sessions/${c.sessionId}/tracks/new`, {
    ...description,
    tracks: list,
  })) as { tracks?: { trackName?: unknown; errorCode?: unknown }[] };
  if (list[0]?.location === "local") {
    const published = (result.tracks ?? [])
      .filter((t) => t.errorCode === undefined && typeof t.trackName === "string")
      .map((t) => t.trackName as string)
      .filter((name) => list.some((t) => t.trackName === name));
    if (published.length > 0) await room(c).publishTracks(c.who, c.sessionId, published);
  }
  return json(result);
}

async function renegotiate(c: Context): Promise<Response> {
  const body = await readJson(c.request);
  onlyFields(body, ["sessionDescription"], "the body");
  const description = sessionDescription(body.sessionDescription);
  const allowed = await room(c).authorizeSession(c.who, c.sessionId);
  if (!allowed.ok) return error(allowed.status, allowed.code, allowed.message);
  return json(await sfu(c.env, "PUT", `/sessions/${c.sessionId}/renegotiate`, { sessionDescription: description }));
}

async function closeTracks(c: Context): Promise<Response> {
  const body = await readJson(c.request);
  onlyFields(body, ["tracks", "sessionDescription", "force"], "the body");
  if (!Array.isArray(body.tracks) || body.tracks.length === 0 || body.tracks.length > MAX_TRACKS) {
    throw invalid(`tracks must be a list of 1 to ${MAX_TRACKS}.`);
  }
  const mids = (body.tracks as unknown[]).map((t, i) => {
    const mid = (t as { mid?: unknown } | null)?.mid;
    if (typeof mid !== "string" || !MID.test(mid) || Object.keys(t as object).length !== 1) {
      throw invalid(`tracks[${i}] must be { mid }.`);
    }
    return { mid };
  });
  if (typeof body.force !== "boolean") throw invalid("force must be true or false.");
  const description = optionalDescription(body);
  const allowed = await room(c).authorizeSession(c.who, c.sessionId);
  if (!allowed.ok) return error(allowed.status, allowed.code, allowed.message);
  return json(
    await sfu(c.env, "PUT", `/sessions/${c.sessionId}/tracks/close`, {
      ...description,
      tracks: mids,
      force: body.force,
    }),
  );
}
