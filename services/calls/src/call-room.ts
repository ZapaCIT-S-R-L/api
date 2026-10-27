// One Durable Object per call: the roster, the key epoch, the events WebSocket (hibernating), the relay of sealed
// key envelopes and the timers (ring timeout, maximum duration, reconnect grace). It never sees a call key: the
// envelopes are libsignal ciphertext for one device each, and the audio never passes through here.
//
// Key rotation: every join and leave bumps `epoch`. The key leader (the longest-present participant) then makes a
// new random call key and sends it sealed to every other participant device (a `keys` message per epoch). An
// envelope for a device that is not connected yet waits here until it connects, for the current epoch only.
import { DurableObject } from "cloudflare:workers";
import type { Caller, Role } from "./auth";
import type { Env } from "./env";
import { limits } from "./limits";
import { pushProvider } from "./push";

export type EndReason = "hung_up" | "no_answer" | "declined" | "max_duration" | "disconnected";
type State = "ringing" | "active" | "ended";

interface Participant {
  accountId: string;
  deviceId: number;
  role: Role;
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

export const deviceKey = (accountId: string, deviceId: number) => JSON.stringify([accountId, deviceId]);

interface SocketInfo {
  accountId: string;
  deviceId: number;
}

export class CallRoom extends DurableObject<Env> {
  private call: CallState | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.call = (await ctx.storage.get<CallState>("call")) ?? null;
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  // ---- RPC from the Worker (src/calls.ts); every method gets the verified caller ----

  async start(callId: string, conversationId: string, who: Caller): Promise<Result<CallView>> {
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
    const call = this.visible(who);
    return Promise.resolve(call ? ok(this.view()) : notFound());
  }

  async join(who: Caller): Promise<Result<CallView>> {
    const call = this.visible(who);
    if (!call) return notFound();
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
    const call = this.visible(who);
    if (!call) return notFound();
    const p = this.find(who);
    if (call.state !== "ended" && p) await this.remove(p, "left");
    return ok(null);
  }

  async decline(who: Caller): Promise<Result<null>> {
    const call = this.visible(who);
    if (!call) return notFound();
    if (call.state === "ended") return fail(410, "call_ended", "The call has ended.");
    if (!call.declined.includes(who.accountId)) call.declined.push(who.accountId);
    await this.save();
    this.broadcast({ type: "declined", accountId: who.accountId });
    this.broadcastRoster();
    return ok(null);
  }

  // The caller must be a participant (before the Worker creates an SFU session for them).
  async requireParticipant(who: Caller): Promise<Result<null>> {
    const call = this.visible(who);
    if (!call) return notFound();
    if (call.state === "ended") return fail(410, "call_ended", "The call has ended.");
    return Promise.resolve(this.find(who) ? ok(null) : fail(403, "not_participant", "Join the call first."));
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

  // ---- The events WebSocket (the Worker forwards the upgrade with the verified caller) ----

  override async fetch(request: Request): Promise<Response> {
    const who = JSON.parse(request.headers.get("x-zapakid-caller") ?? "null") as Caller | null;
    if (!who) return new Response(null, { status: 400 });
    const call = this.visible(who);
    if (!call) return Response.json({ error: { code: "not_found", message: "No such call." } }, { status: 404 });
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
    server.serializeAttachment({ accountId: who.accountId, deviceId: who.deviceId } satisfies SocketInfo);
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
    const call = this.call;
    if (!call) return;
    const now = Date.now();
    if (call.state === "ended") {
      if (now >= (call.endedAt ?? 0) + KEEP_ENDED_MS) {
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

  private visible(who: Caller): CallState | null {
    const call = this.call;
    if (!call || !who.conversations.includes(call.conversationId)) return null;
    return call;
  }

  private find(who: { accountId: string; deviceId: number }): Participant | undefined {
    return this.call?.participants.find((p) => p.accountId === who.accountId && p.deviceId === who.deviceId);
  }

  private ringing(call: CallState) {
    return { callId: call.callId, conversationId: call.conversationId, from: call.createdBy.accountId };
  }

  private async save(): Promise<void> {
    if (this.call) await this.ctx.storage.put("call", this.call);
    await this.schedule();
  }

  private async schedule(): Promise<void> {
    const call = this.call;
    if (!call) return;
    let next: number;
    if (call.state === "ended") {
      next = (call.endedAt ?? Date.now()) + KEEP_ENDED_MS;
    } else {
      const l = limits(this.env);
      const due = [call.createdAt + l.maxCallSeconds * 1000];
      if (call.state === "ringing") due.push(call.createdAt + l.ringTimeoutSeconds * 1000);
      for (const p of call.participants) {
        if (p.disconnectedAt !== null) due.push(p.disconnectedAt + l.reconnectGraceSeconds * 1000);
      }
      next = Math.min(...due);
    }
    if ((await this.ctx.storage.getAlarm()) !== next) await this.ctx.storage.setAlarm(next);
  }

  private async remove(p: Participant, reason: "left" | "disconnected"): Promise<void> {
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
    this.broadcast({ type: "left", accountId: p.accountId, deviceId: p.deviceId, epoch: call.epoch, reason });
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
