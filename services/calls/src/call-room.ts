// One Durable Object per call: the roster, the key epoch, the events WebSocket (hibernating), the relay of sealed
// key envelopes and the timers (ring timeout, maximum duration, reconnect grace). It never sees a call key: the
// envelopes are libsignal ciphertext for one device each, and the audio never passes through here.
//
// Key rotation: every join and leave bumps `epoch`. The key leader (the longest-present participant) then makes a
// new random call key and sends it sealed to every other participant device (a `keys` message per epoch). An
// envelope for a device that is not connected yet waits here until it connects, for the current epoch only.
// A member the chat service removes from the conversation (src/conversation-events.ts) is dropped the same way:
// their devices leave with reason `removed`, the epoch moves on without them, their sockets are closed, and their
// SFU sessions are closed: kept in `closing` and retried from the alarm with backoff (a bounded number of times)
// until Realtime confirms or says the session is gone. A session whose retries run out stays on the list, logged,
// and keeps the call's state from being deleted: a pending clean-up is never silently dropped.
import { DurableObject } from "cloudflare:workers";
import type { Caller, Role } from "./auth";
import { ChatUnavailable, membership, revoked } from "./chat";
import type { Env } from "./env";
import { limits } from "./limits";
import { pushProvider } from "./push";
import { closeSession, RealtimeRejected, RealtimeUnavailable } from "./realtime";

export type EndReason = "hung_up" | "no_answer" | "declined" | "max_duration" | "disconnected";
type State = "ringing" | "active" | "ended";
// Why a participant left: hung up, lost the connection for longer than the grace, the account signed out
// everywhere (its chat token was revoked, api #81), or the chat service removed it from the conversation.
export type LeaveReason = "left" | "disconnected" | "revoked" | "removed";

interface Participant {
  accountId: string;
  deviceId: number;
  role: Role;
  // The chat token's session epoch at join (missing in calls from before it was kept: counts as 0).
  sep?: number;
  joinedAt: number;
  sessionId: string | null;
  tracks: string[];
  // Since when no events WebSocket of this device is open (null while one is). Joining counts as disconnected
  // until the phone connects.
  disconnectedAt: number | null;
}

interface PendingKey {
  to: string;
  epoch: number;
  fromAccount: string;
  fromDevice: number;
  blob: string;
}

// An SFU session of a dropped device whose tracks are not closed yet (src/realtime.ts closeSession).
interface PendingClose {
  sessionId: string;
  attempts: number;
  // When to try (again).
  nextAt: number;
  // Set when CLOSE_MAX_ATTEMPTS failed: no more retries, but kept (and logged) since the tracks may still be open.
  exhausted?: true;
}

interface CallState {
  callId: string;
  conversationId: string;
  createdBy: { accountId: string; deviceId: number };
  createdAt: number;
  answeredAt: number | null;
  state: State;
  endedAt: number | null;
  endReason: EndReason | null;
  epoch: number;
  participants: Participant[];
  declined: string[];
  peak: number;
  pending: PendingKey[];
  // The devices rung at the start (the other members' devices, from the chat service), to cancel the same ring.
  // Missing in calls started before it was kept.
  ring?: { accountId: string; deviceId: number }[];
  // When the participants' chat tokens are next checked for revocation with the chat service (api #81). Missing in
  // calls from before it was kept: checked at the next alarm.
  revalidateAt?: number;
  // SFU sessions of dropped devices still to close. Missing in calls started before it was kept.
  closing?: PendingClose[];
}

export interface CallView {
  callId: string;
  conversationId: string;
  state: State;
  createdAt: string;
  ringDeadline: string;
  epoch: number;
  keyLeader: { accountId: string; deviceId: number } | null;
  participants: {
    accountId: string;
    deviceId: number;
    role: Role;
    joinedAt: string;
    sessionId: string | null;
    tracks: string[];
    connected: boolean;
  }[];
  declined: string[];
  endReason: EndReason | null;
}

export type Result<T> = { ok: true; value: T } | { ok: false; status: number; code: string; message: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(status: number, code: string, message: string): Result<T> => ({ ok: false, status, code, message });
const notFound = <T>() => fail<T>(404, "not_found", "No such call.");

// After a call ends its state stays an hour (late requests get 410 call_ended), then it is deleted.
const KEEP_ENDED_MS = 60 * 60 * 1000;
const MAX_ENVELOPES = 8;
// A libsignal PreKeySignalMessage (PQXDH, with the Kyber ciphertext) sealing a 32-byte key fits in 3 KiB.
const MAX_BLOB_CHARS = 4096;
const MAX_MESSAGE_CHARS = 64 * 1024;
const MAX_TRACKS = 16;
const MAX_SOCKETS = 32;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// How often a live call asks the chat service whether a participant's chat token was revoked (a logout-all): the
// longest a lost phone stays in a call it joined before the sign-out. The chat service is also asked before every
// key a phone relays.
export const REVALIDATE_MS = 60 * 1000;
// Close code for a socket whose chat token was revoked: the app asks the account API for a new token (and gets 401
// until the parent signs in again), as for an expired one.
export const CLOSE_TOKEN_REVOKED = 4401;
// Closing a dropped device's SFU tracks is retried with this backoff (5 s, 10 s, 20 s... 5 min), or later when
// Realtime's Retry-After says so (up to an hour), at most CLOSE_MAX_ATTEMPTS times in all (about 20 minutes).
const CLOSE_RETRY_MS = 5_000;
const CLOSE_RETRY_MAX_MS = 5 * 60_000;
const CLOSE_RETRY_AFTER_MAX_MS = 60 * 60_000;
const CLOSE_MAX_ATTEMPTS = 10;
// Realtime no longer has the session: nothing left to close.
const SESSION_GONE = new Set([404, 410]);

export const deviceKey = (accountId: string, deviceId: number) => JSON.stringify([accountId, deviceId]);

interface SocketInfo {
  accountId: string;
  deviceId: number;
  // The chat token's session epoch (missing on sockets from before it was kept: counts as 0).
  sep?: number;
}

export class CallRoom extends DurableObject<Env> {
  private call: CallState | null = null;
  // One closeSessions() run at a time (the RPC and the alarm may overlap).
  private closingNow = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.call = (await ctx.storage.get<CallState>("call")) ?? null;
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  // ---- RPC from the Worker (src/calls.ts); every method gets the verified caller ----

  // The Worker has checked with the chat service that the caller is a member of the conversation.
  async start(
    callId: string,
    conversationId: string,
    who: Caller,
    ring: { accountId: string; deviceId: number }[] = [],
  ): Promise<Result<CallView>> {
    if (this.call) return fail(409, "call_exists", "This call id is taken.");
    const now = Date.now();
    this.call = {
      callId,
      conversationId,
      createdBy: { accountId: who.accountId, deviceId: who.deviceId },
      createdAt: now,
      answeredAt: null,
      state: "ringing",
      endedAt: null,
      endReason: null,
      epoch: 1,
      participants: [participant(who, now)],
      declined: [],
      peak: 1,
      pending: [],
      ring,
      revalidateAt: now + REVALIDATE_MS,
      closing: [],
    };
    await this.env.DB.prepare(
      "INSERT INTO calls (id, conversation_id, created_by_account, created_by_device, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(callId, conversationId, who.accountId, who.deviceId, new Date(now).toISOString())
      .run();
    await this.save();
    return ok(this.view());
  }

  async snapshot(who: Caller): Promise<Result<CallView>> {
    const access = await this.access(who);
    return access.ok ? ok(this.view()) : access;
  }

  async join(who: Caller): Promise<Result<CallView>> {
    const access = await this.access(who);
    if (!access.ok) return access;
    const call = access.value;
    if (call.state === "ended") return fail(410, "call_ended", "The call has ended.");
    if (this.find(who)) return ok(this.view());
    if (call.participants.length >= limits(this.env).maxParticipants) {
      return fail(409, "call_full", "The call is full.");
    }
    const now = Date.now();
    call.participants.push(participant(who, now));
    call.epoch++;
    call.pending = [];
    call.peak = Math.max(call.peak, call.participants.length);
    const answered = call.answeredAt === null;
    if (answered) {
      call.answeredAt = now;
      call.state = "active";
    }
    await this.save();
    await this.env.DB.prepare(
      "UPDATE calls SET answered_at = coalesce(answered_at, ?), peak_participants = max(peak_participants, ?) WHERE id = ?",
    )
      .bind(new Date(now).toISOString(), call.peak, call.callId)
      .run();
    if (answered) await pushProvider().cancel(this.ringing(call));
    this.broadcast({ type: "joined", accountId: who.accountId, deviceId: who.deviceId, epoch: call.epoch });
    this.broadcastRoster();
    return ok(this.view());
  }

  async leave(who: Caller): Promise<Result<null>> {
    const access = await this.access(who);
    if (!access.ok) return access;
    const call = access.value;
    const p = this.find(who);
    if (call.state !== "ended" && p) await this.remove(p, "left");
    return ok(null);
  }

  async decline(who: Caller): Promise<Result<null>> {
    const access = await this.access(who);
    if (!access.ok) return access;
    const call = access.value;
    if (call.state === "ended") return fail(410, "call_ended", "The call has ended.");
    if (!call.declined.includes(who.accountId)) call.declined.push(who.accountId);
    await this.save();
    this.broadcast({ type: "declined", accountId: who.accountId });
    this.broadcastRoster();
    return ok(null);
  }

  // The caller must be a participant (before the Worker creates an SFU session for them).
  async requireParticipant(who: Caller): Promise<Result<null>> {
    const access = await this.access(who);
    if (!access.ok) return access;
    if (access.value.state === "ended") return fail(410, "call_ended", "The call has ended.");
    return this.find(who) ? ok(null) : fail(403, "not_participant", "Join the call first.");
  }

  async attachSession(who: Caller, sessionId: string): Promise<Result<null>> {
    const checked = await this.requireParticipant(who);
    if (!checked.ok) return checked;
    const p = this.find(who);
    if (!p) return fail(403, "not_participant", "Join the call first.");
    p.sessionId = sessionId;
    p.tracks = [];
    await this.save();
    this.broadcastRoster();
    return ok(null);
  }

  // `sessionId` must be the caller's own SFU session; remote tracks must be published by another participant.
  async authorizeSession(
    who: Caller,
    sessionId: string,
    remote: { sessionId: string; trackName: string }[] = [],
  ): Promise<Result<null>> {
    const checked = await this.requireParticipant(who);
    if (!checked.ok) return checked;
    const p = this.find(who);
    if (p?.sessionId !== sessionId) return fail(403, "not_your_session", "That SFU session is not yours.");
    for (const track of remote) {
      const owner = this.call?.participants.find((q) => q !== p && q.sessionId === track.sessionId);
      if (!owner?.tracks.includes(track.trackName)) {
        return fail(403, "track_not_in_call", "That track is not published in this call.");
      }
    }
    return ok(null);
  }

  async publishTracks(who: Caller, sessionId: string, trackNames: string[]): Promise<Result<null>> {
    const checked = await this.authorizeSession(who, sessionId);
    if (!checked.ok) return checked;
    const p = this.find(who);
    if (!p) return fail(403, "not_participant", "Join the call first.");
    for (const name of trackNames) if (!p.tracks.includes(name) && p.tracks.length < MAX_TRACKS) p.tracks.push(name);
    await this.save();
    this.broadcastRoster();
    return ok(null);
  }

  // ---- From the chat service (the conversation events queue, src/conversation-events.ts); no caller check: the
  // chat service is the source of membership, and only Workers of this account produce into the queue ----

  // These accounts were removed from the conversation at `occurredAt` (ms): every device of theirs leaves the call
  // now (reason `removed`), the key epoch moves on without them, their events sockets are closed and their SFU
  // sessions are closed (retried until done). A no-op for accounts not in the call. Stale events are ignored: one
  // older than the call, or, per device, older than its join (the member was readmitted meanwhile; every join asks
  // the chat service). Returns the devices dropped.
  async removeMembers(accountIds: string[], occurredAt: number): Promise<{ accountId: string; deviceId: number }[]> {
    const call = this.call;
    if (!call || call.state === "ended" || occurredAt < call.createdAt) return [];
    const gone = new Set(accountIds);
    if (call.ring) call.ring = call.ring.filter((r) => !gone.has(r.accountId));
    const dropped = call.participants.filter((p) => gone.has(p.accountId) && p.joinedAt <= occurredAt);
    await this.drop(dropped);
    return dropped.map((p) => ({ accountId: p.accountId, deviceId: p.deviceId }));
  }

  // The conversation was closed at `occurredAt` (ms; read-only, no calls): everyone leaves and the call ends. A
  // call started after that is left alone (stale event).
  async conversationClosed(occurredAt: number): Promise<{ accountId: string; deviceId: number }[]> {
    const call = this.call;
    if (!call || call.state === "ended" || occurredAt < call.createdAt) return [];
    call.ring = [];
    const dropped = [...call.participants];
    await this.drop(dropped);
    return dropped.map((p) => ({ accountId: p.accountId, deviceId: p.deviceId }));
  }

  // SFU sessions of dropped devices not closed yet (tests and operators).
  pendingCloses(): PendingClose[] {
    return this.call?.closing ?? [];
  }

  // ---- The events WebSocket (the Worker forwards the upgrade with the verified caller) ----

  override async fetch(request: Request): Promise<Response> {
    const who = JSON.parse(request.headers.get("x-zapakid-caller") ?? "null") as Caller | null;
    if (!who) return new Response(null, { status: 400 });
    const access = await this.access(who);
    if (!access.ok) {
      return Response.json({ error: { code: access.code, message: access.message } }, { status: access.status });
    }
    const call = access.value;
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return Response.json(
        { error: { code: "too_many_connections", message: "Too many connections." } },
        { status: 429 },
      );
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const key = deviceKey(who.accountId, who.deviceId);
    this.ctx.acceptWebSocket(server, [key]);
    server.serializeAttachment({ accountId: who.accountId, deviceId: who.deviceId, sep: who.sep } satisfies SocketInfo);
    const p = this.find(who);
    if (p && p.disconnectedAt !== null) {
      p.disconnectedAt = null;
      await this.save();
      await this.schedule();
    }
    send(server, { type: "roster", call: this.view() });
    if (call.state === "ended") {
      send(server, { type: "ended", reason: call.endReason });
      server.close(1000, "call ended");
    } else {
      await this.deliverPending(server, key);
      if (p) this.broadcastRoster();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const info = ws.deserializeAttachment() as SocketInfo;
    if (typeof message !== "string" || message.length > MAX_MESSAGE_CHARS) {
      send(ws, { type: "error", code: "invalid_message", message: "Send JSON text messages under 64 KiB." });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      send(ws, { type: "error", code: "invalid_message", message: "Not JSON." });
      return;
    }
    const keys = parseKeys(parsed);
    if (typeof keys === "string") {
      send(ws, { type: "error", code: "invalid_message", message: keys });
      return;
    }
    // A phone whose account signed out everywhere must not hand out call keys (api #81).
    let gone: boolean;
    try {
      gone = await revoked(this.env, { accountId: info.accountId, sep: info.sep ?? 0 });
    } catch (e) {
      if (!(e instanceof ChatUnavailable)) throw e;
      console.error(JSON.stringify({ msg: "chat unavailable", err: e.message }));
      send(ws, { type: "error", code: "chat_unavailable", message: "Try again in a moment." });
      return;
    }
    if (gone) {
      await this.revoke(info);
      return;
    }
    await this.relayKeys(ws, info, keys);
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const info = ws.deserializeAttachment() as SocketInfo | null;
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {
      // Already closed.
    }
    if (!info) return;
    await this.disconnected(ws, info);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    const info = ws.deserializeAttachment() as SocketInfo | null;
    if (info) await this.disconnected(ws, info);
  }

  // ---- Timers: ring timeout, maximum duration, reconnect grace, cleanup after the end ----

  override async alarm(): Promise<void> {
    await this.closeSessions();
    const call = this.call;
    if (!call) return;
    const now = Date.now();
    if (call.state === "ended") {
      // Deleted an hour after the end, but not while a session is still to close (see schedule()).
      if (now >= (call.endedAt ?? 0) + KEEP_ENDED_MS && !call.closing?.length) {
        this.call = null;
        await this.ctx.storage.deleteAll();
      } else {
        await this.schedule();
      }
      return;
    }
    const l = limits(this.env);
    if (now >= call.createdAt + l.maxCallSeconds * 1000) {
      await this.end("max_duration");
      return;
    }
    if (call.state === "ringing" && now >= call.createdAt + l.ringTimeoutSeconds * 1000) {
      await this.end("no_answer");
      return;
    }
    if (now >= (call.revalidateAt ?? 0)) {
      await this.revalidate(call, now);
      if (this.call?.state === "ended") return;
    }
    const gone = call.participants.filter(
      (p) => p.disconnectedAt !== null && now >= p.disconnectedAt + l.reconnectGraceSeconds * 1000,
    );
    for (const p of gone) {
      if (this.call?.state === "ended") break;
      await this.remove(p, "disconnected");
    }
    await this.schedule();
  }

  // ---- Internals ----

  // The call, if the caller is a current member of its conversation. The chat service is asked every time, so a
  // member removed from the conversation can't see, join or rejoin its calls (404, as for a call that doesn't exist).
  private async access(who: Caller): Promise<Result<CallState>> {
    const asked = this.call;
    if (!asked) return notFound();
    try {
      if (!(await membership(this.env, asked.conversationId, who.accountId)).member) return notFound();
    } catch (e) {
      if (!(e instanceof ChatUnavailable)) throw e;
      console.error(JSON.stringify({ msg: "chat unavailable", err: e.message }));
      return fail(503, "chat_unavailable", "Calls are unavailable right now. Try again later.");
    }
    // Other requests may have run during the RPC: use the call as it is now.
    const call = this.call;
    return call?.callId === asked.callId ? ok(call) : notFound();
  }

  private find(who: { accountId: string; deviceId: number }): Participant | undefined {
    return this.call?.participants.find((p) => p.accountId === who.accountId && p.deviceId === who.deviceId);
  }

  private ringing(call: CallState) {
    return {
      callId: call.callId,
      conversationId: call.conversationId,
      from: call.createdBy.accountId,
      to: call.ring ?? [],
    };
  }

  private async save(): Promise<void> {
    if (this.call) await this.ctx.storage.put("call", this.call);
    await this.schedule();
  }

  private async schedule(): Promise<void> {
    const call = this.call;
    if (!call) return;
    // While closeSessions() runs, its retries are scheduled when it is done (no alarm storm meanwhile).
    const due = this.closingNow ? [] : (call.closing ?? []).flatMap((c) => (c.exhausted ? [] : [c.nextAt]));
    if (call.state === "ended") {
      // The ended call is deleted after its hour once no session is left to close; with only exhausted ones left
      // nothing is due: the state stays, for an operator (logged as "sfu session close retries exhausted").
      if (!call.closing?.length) due.push((call.endedAt ?? Date.now()) + KEEP_ENDED_MS);
    } else {
      const l = limits(this.env);
      due.push(call.createdAt + l.maxCallSeconds * 1000, call.revalidateAt ?? Date.now());
      if (call.state === "ringing") due.push(call.createdAt + l.ringTimeoutSeconds * 1000);
      for (const p of call.participants) {
        if (p.disconnectedAt !== null) due.push(p.disconnectedAt + l.reconnectGraceSeconds * 1000);
      }
    }
    if (due.length === 0) {
      // While closeSessions() runs, it schedules when it is done.
      if (!this.closingNow) await this.ctx.storage.deleteAlarm();
      return;
    }
    const next = Math.min(...due);
    if ((await this.ctx.storage.getAlarm()) !== next) await this.ctx.storage.setAlarm(next);
  }

  // Asks the chat service whether any participant's chat token was revoked since the last check, and removes those
  // (api #81). A chat outage leaves everyone in and tries again at the next check.
  private async revalidate(call: CallState, now: number): Promise<void> {
    call.revalidateAt = now + REVALIDATE_MS;
    for (const p of [...call.participants]) {
      if (this.call?.state === "ended") return;
      let gone: boolean;
      try {
        gone = await revoked(this.env, { accountId: p.accountId, sep: p.sep ?? 0 });
      } catch (e) {
        if (!(e instanceof ChatUnavailable)) throw e;
        console.error(JSON.stringify({ msg: "chat unavailable", err: e.message }));
        break;
      }
      if (gone) await this.revoke(p);
    }
    if (this.call?.state !== "ended") await this.save();
  }

  // The account signed out everywhere: its device leaves the call (the others get a new call key), its sockets are
  // closed and its SFU session goes on the closing list, as for a device the chat service removed.
  private async revoke(device: { accountId: string; deviceId: number }): Promise<void> {
    const p = this.find(device);
    const call = this.call;
    if (p && call && call.state !== "ended") {
      if (p.sessionId) {
        call.closing = [...(call.closing ?? []), { sessionId: p.sessionId, attempts: 0, nextAt: Date.now() }];
      }
      await this.remove(p, "revoked");
    }
    for (const ws of this.ctx.getWebSockets(deviceKey(device.accountId, device.deviceId))) {
      try {
        ws.close(CLOSE_TOKEN_REVOKED, "session revoked");
      } catch {
        // Already closed.
      }
    }
    await this.closeSessions();
  }

  // Drops participants the chat service removed. The `left` events carry the new epoch, so the key leader rotates the
  // call key without them; their sockets are closed right after, and they get 404 from then on (`access`). Their
  // SFU sessions go on the closing list, saved with the roster change, and are closed right away or on retry.
  private async drop(gone: Participant[]): Promise<void> {
    const call = this.call;
    if (!call || gone.length === 0) return;
    const now = Date.now();
    call.closing = [
      ...(call.closing ?? []),
      ...gone.flatMap((p) => (p.sessionId ? [{ sessionId: p.sessionId, attempts: 0, nextAt: now }] : [])),
    ];
    call.participants = call.participants.filter((p) => !gone.includes(p));
    call.epoch++;
    call.pending = [];
    for (const p of gone) {
      this.broadcast({
        type: "left",
        accountId: p.accountId,
        deviceId: p.deviceId,
        epoch: call.epoch,
        reason: "removed",
      });
    }
    if (call.participants.length === 0) {
      await this.end("hung_up");
      await this.closeSessions();
      return;
    }
    await this.save();
    for (const p of gone) {
      for (const ws of this.ctx.getWebSockets(deviceKey(p.accountId, p.deviceId))) {
        try {
          ws.close(4403, "removed from the conversation");
        } catch {
          // Already closed.
        }
      }
    }
    this.broadcastRoster();
    await this.closeSessions();
  }

  // Closes the SFU tracks of every session on the closing list that is due. Done when Realtime confirms, or says the
  // session is gone (404, 410). On any other failure (unavailable, rate limited, another refusal) the session stays on
  // the list and the alarm tries again with backoff, not before Retry-After; after CLOSE_MAX_ATTEMPTS it stays on the
  // list without retries. The roster never waits for this: the rotated key is what keeps a dropped device out.
  private async closeSessions(): Promise<void> {
    if (this.closingNow) return;
    this.closingNow = true;
    try {
      for (;;) {
        const call = this.call;
        const now = Date.now();
        const next = call?.closing?.find((c) => !c.exhausted && c.nextAt <= now);
        if (!call || !next) break;
        let done = true;
        let retryAfterMs = 0;
        try {
          await closeSession(this.env, next.sessionId);
        } catch (e) {
          if (!(e instanceof RealtimeUnavailable || e instanceof RealtimeRejected)) throw e;
          done = e instanceof RealtimeRejected && SESSION_GONE.has(e.upstreamStatus);
          if (e instanceof RealtimeUnavailable) retryAfterMs = Math.min(e.retryAfterMs, CLOSE_RETRY_AFTER_MAX_MS);
          console.error(JSON.stringify({ msg: "sfu session not closed", callId: call.callId, done, err: e.message }));
        }
        // The call may have changed, or been deleted, during the request: update it as it is now.
        const current = this.call;
        if (!current?.closing || current.callId !== call.callId) break;
        if (done) {
          current.closing = current.closing.filter((c) => c !== next);
        } else if (++next.attempts >= CLOSE_MAX_ATTEMPTS) {
          next.exhausted = true;
          console.error(
            JSON.stringify({
              msg: "sfu session close retries exhausted",
              callId: call.callId,
              sessionId: next.sessionId,
              attempts: next.attempts,
            }),
          );
        } else {
          const backoff = Math.min(CLOSE_RETRY_MS * 2 ** (next.attempts - 1), CLOSE_RETRY_MAX_MS);
          next.nextAt = Date.now() + Math.max(backoff, retryAfterMs);
        }
        await this.save();
      }
    } finally {
      this.closingNow = false;
      await this.schedule();
    }
  }

  private async remove(p: Participant, reason: "left" | "disconnected" | "revoked"): Promise<void> {
    const call = this.call;
    if (!call) return;
    call.participants = call.participants.filter((q) => q !== p);
    call.epoch++;
    call.pending = [];
    if (call.participants.length === 0) {
      await this.end(reason === "left" ? "hung_up" : "disconnected");
      return;
    }
    await this.save();
    this.broadcast({
      type: "left",
      accountId: p.accountId,
      deviceId: p.deviceId,
      epoch: call.epoch,
      reason: reason satisfies LeaveReason,
    });
    this.broadcastRoster();
  }

  private async end(reason: EndReason): Promise<void> {
    const call = this.call;
    if (!call || call.state === "ended") return;
    const unanswered = call.answeredAt === null;
    const final: EndReason = reason === "hung_up" && unanswered && call.declined.length > 0 ? "declined" : reason;
    call.state = "ended";
    call.endedAt = Date.now();
    call.endReason = final;
    call.participants = [];
    call.pending = [];
    await this.save();
    await this.env.DB.prepare("UPDATE calls SET ended_at = ?, end_reason = ? WHERE id = ?")
      .bind(new Date(call.endedAt).toISOString(), final, call.callId)
      .run();
    if (unanswered) await pushProvider().cancel(this.ringing(call));
    this.broadcast({ type: "ended", reason: final });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "call ended");
      } catch {
        // Already closed.
      }
    }
  }

  private async disconnected(ws: WebSocket, info: SocketInfo): Promise<void> {
    const p = this.find(info);
    if (!p || this.call?.state === "ended") return;
    const others = this.ctx
      .getWebSockets(deviceKey(info.accountId, info.deviceId))
      .filter((s) => s !== ws && s.readyState === WebSocket.OPEN);
    if (others.length > 0) return;
    p.disconnectedAt = Date.now();
    await this.save();
    this.broadcastRoster();
  }

  private async relayKeys(ws: WebSocket, from: SocketInfo, keys: KeysMessage): Promise<void> {
    const call = this.call;
    if (!call || call.state === "ended" || !this.find(from)) {
      send(ws, { type: "error", code: "not_participant", message: "Join the call first." });
      return;
    }
    if (keys.epoch !== call.epoch) {
      send(ws, {
        type: "error",
        code: "stale_epoch",
        message: `The current epoch is ${call.epoch}.`,
        epoch: call.epoch,
      });
      return;
    }
    const self = deviceKey(from.accountId, from.deviceId);
    for (const e of keys.envelopes) {
      const to = deviceKey(e.toAccount, e.toDevice);
      if (to === self || !this.find({ accountId: e.toAccount, deviceId: e.toDevice })) {
        send(ws, { type: "error", code: "not_participant", message: "An envelope is for a device not in the call." });
        return;
      }
    }
    let delivered = 0;
    let queued = 0;
    for (const e of keys.envelopes) {
      const to = deviceKey(e.toAccount, e.toDevice);
      const message = {
        type: "key",
        epoch: call.epoch,
        fromAccount: from.accountId,
        fromDevice: from.deviceId,
        blob: e.blob,
      };
      const sockets = this.ctx.getWebSockets(to).filter((s) => s.readyState === WebSocket.OPEN);
      if (sockets.length > 0) {
        for (const s of sockets) send(s, message);
        delivered++;
      } else {
        call.pending = call.pending.filter(
          (k) => !(k.to === to && k.fromAccount === from.accountId && k.fromDevice === from.deviceId),
        );
        call.pending.push({
          to,
          epoch: call.epoch,
          fromAccount: from.accountId,
          fromDevice: from.deviceId,
          blob: e.blob,
        });
        queued++;
      }
    }
    if (queued > 0) await this.save();
    send(ws, { type: "keys_ack", epoch: call.epoch, delivered, queued });
  }

  private async deliverPending(ws: WebSocket, key: string): Promise<void> {
    const call = this.call;
    if (!call) return;
    const mine = call.pending.filter((k) => k.to === key && k.epoch === call.epoch);
    if (mine.length === 0) return;
    for (const k of mine) {
      send(ws, { type: "key", epoch: k.epoch, fromAccount: k.fromAccount, fromDevice: k.fromDevice, blob: k.blob });
    }
    call.pending = call.pending.filter((k) => k.to !== key);
    await this.save();
  }

  private broadcast(message: unknown): void {
    for (const ws of this.ctx.getWebSockets()) send(ws, message);
  }

  private broadcastRoster(): void {
    if (this.call) this.broadcast({ type: "roster", call: this.view() });
  }

  private view(): CallView {
    const call = this.call;
    if (!call) throw new Error("no call");
    const ring = limits(this.env).ringTimeoutSeconds;
    const leader = call.participants[0];
    return {
      callId: call.callId,
      conversationId: call.conversationId,
      state: call.state,
      createdAt: new Date(call.createdAt).toISOString(),
      ringDeadline: new Date(call.createdAt + ring * 1000).toISOString(),
      epoch: call.epoch,
      keyLeader: leader ? { accountId: leader.accountId, deviceId: leader.deviceId } : null,
      participants: call.participants.map((p) => ({
        accountId: p.accountId,
        deviceId: p.deviceId,
        role: p.role,
        joinedAt: new Date(p.joinedAt).toISOString(),
        sessionId: p.sessionId,
        tracks: p.tracks,
        connected: this.ctx
          .getWebSockets(deviceKey(p.accountId, p.deviceId))
          .some((s) => s.readyState === WebSocket.OPEN),
      })),
      declined: call.declined,
      endReason: call.endReason,
    };
  }
}

function participant(who: Caller, now: number): Participant {
  return {
    accountId: who.accountId,
    deviceId: who.deviceId,
    role: who.role,
    sep: who.sep,
    joinedAt: now,
    sessionId: null,
    tracks: [],
    disconnectedAt: now,
  };
}

function send(ws: WebSocket, message: unknown): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // The socket closed meanwhile; webSocketClose handles it.
  }
}

interface KeysMessage {
  epoch: number;
  envelopes: { toAccount: string; toDevice: number; blob: string }[];
}

// A `keys` message, or why it is invalid.
function parseKeys(value: unknown): KeysMessage | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "Send a JSON object.";
  const m = value as Record<string, unknown>;
  if (m.type !== "keys") return 'Unknown message type (only "keys" and "ping").';
  if (Object.keys(m).some((k) => !["type", "epoch", "envelopes"].includes(k))) return "Unknown field.";
  if (typeof m.epoch !== "number" || !Number.isInteger(m.epoch) || m.epoch < 1)
    return "epoch must be a positive integer.";
  if (!Array.isArray(m.envelopes) || m.envelopes.length === 0 || m.envelopes.length > MAX_ENVELOPES) {
    return `envelopes must be a list of 1 to ${MAX_ENVELOPES}.`;
  }
  const envelopes: KeysMessage["envelopes"] = [];
  for (const raw of m.envelopes as unknown[]) {
    if (typeof raw !== "object" || raw === null) return "Each envelope is an object.";
    const e = raw as Record<string, unknown>;
    if (Object.keys(e).some((k) => !["toAccount", "toDevice", "blob"].includes(k))) return "Unknown envelope field.";
    if (typeof e.toAccount !== "string" || e.toAccount.length === 0 || e.toAccount.length > 128)
      return "Bad toAccount.";
    if (typeof e.toDevice !== "number" || !Number.isInteger(e.toDevice) || e.toDevice < 1 || e.toDevice > 127) {
      return "toDevice must be 1-127.";
    }
    if (typeof e.blob !== "string" || e.blob.length > MAX_BLOB_CHARS || !BASE64.test(e.blob)) {
      return `blob must be base64, at most ${MAX_BLOB_CHARS} characters.`;
    }
    envelopes.push({ toAccount: e.toAccount, toDevice: e.toDevice, blob: e.blob });
  }
  return { epoch: m.epoch, envelopes };
}
