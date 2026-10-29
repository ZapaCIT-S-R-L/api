// One Durable Object per conversation (SQLite storage, EU jurisdiction): the delivery copies of its envelopes, one
// per recipient device until that device acknowledges them, and the live WebSocket stream (hibernation API, so an
// idle conversation costs nothing). The Worker checks the chat token and membership before calling in; the object
// trusts its caller and never sees anything but ciphertext.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { RoomEventKind, Rooms } from "./rooms";

export type EnvelopeType = "prekey_message" | "message" | "sender_key_message";

export interface StoredEnvelope {
  recipientAccountId: string;
  recipientDeviceId: number;
  type: EnvelopeType;
  content: string;
}

export interface Envelope {
  id: string;
  conversationId: string;
  messageId: string;
  senderAccountId: string;
  senderDeviceId: number;
  type: EnvelopeType;
  content: string;
  serverTimestamp: number;
}

export interface SendInput {
  conversationId: string;
  messageId: string;
  senderAccountId: string;
  senderDeviceId: number;
  envelopes: StoredEnvelope[];
}

export interface SendResult {
  serverTimestamp: number;
  duplicate: boolean;
  // Recipient devices without an open stream: they get a content-free push.
  offline: { accountId: string; deviceId: number }[];
}

interface SocketInfo {
  accountId: string;
  deviceId: number;
  // Chat token expiry, seconds since the epoch.
  exp: number;
  // The chat token's session epoch (`sep`); 0 for tokens without one. Missing on sockets from before api #81.
  sep?: number;
}

// Close codes the apps act on: reconnect with a fresh token (expired or revoked: after a logout-all the account
// service refuses a new one, and the app signs in again) / stop (left the conversation).
export const CLOSE_TOKEN_EXPIRED = 4401;
export const CLOSE_NOT_A_MEMBER = 4403;

// A send's message id is remembered this long, so a retry isn't delivered twice.
const IDEMPOTENCY_MS = 7 * 24 * 60 * 60 * 1000;
const QUEUED_PAGE = 100;

// "Typing..." signals: at most one relayed per device in this window; the rest are dropped.
const TYPING_MIN_INTERVAL_MS = 3000;

const deviceTag = (accountId: string, deviceId: number) => `d:${accountId}:${deviceId}`;
const accountTag = (accountId: string) => `a:${accountId}`;

interface CopyRow extends Record<string, SqlStorageValue> {
  id: string;
  message_id: string;
  sender_account: string;
  sender_device: number;
  type: string;
  content: string;
  server_ts: number;
}

export class ConversationRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  // When each device's last typing signal was relayed (memory only: ephemeral, reset when the object is evicted).
  private readonly typingAt = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.createTables();
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS copies (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        recipient_account TEXT NOT NULL,
        recipient_device INTEGER NOT NULL,
        sender_account TEXT NOT NULL,
        sender_device INTEGER NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        server_ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS copies_recipient ON copies (recipient_account, recipient_device, server_ts);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, server_ts INTEGER NOT NULL);
    `);
  }

  send(input: SendInput): SendResult {
    const now = Date.now();
    const seen = this.sql
      .exec<{ server_ts: number }>("SELECT server_ts FROM messages WHERE id = ?", input.messageId)
      .toArray()[0];
    if (seen) return { serverTimestamp: seen.server_ts, duplicate: true, offline: [] };
    this.sql.exec("DELETE FROM messages WHERE server_ts < ?", now - IDEMPOTENCY_MS);
    this.sql.exec("INSERT INTO messages (id, server_ts) VALUES (?, ?)", input.messageId, now);
    const offline: SendResult["offline"] = [];
    for (const e of input.envelopes) {
      const envelope: Envelope = {
        id: crypto.randomUUID(),
        conversationId: input.conversationId,
        messageId: input.messageId,
        senderAccountId: input.senderAccountId,
        senderDeviceId: input.senderDeviceId,
        type: e.type,
        content: e.content,
        serverTimestamp: now,
      };
      this.sql.exec(
        `INSERT INTO copies (id, message_id, recipient_account, recipient_device, sender_account, sender_device, type, content, server_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        envelope.id,
        envelope.messageId,
        e.recipientAccountId,
        e.recipientDeviceId,
        envelope.senderAccountId,
        envelope.senderDeviceId,
        envelope.type,
        envelope.content,
        now,
      );
      const sockets = this.ctx.getWebSockets(deviceTag(e.recipientAccountId, e.recipientDeviceId));
      const frame = JSON.stringify({ type: "envelope", envelope });
      let delivered = false;
      for (const ws of sockets) delivered = this.trySend(ws, frame) || delivered;
      if (!delivered) offline.push({ accountId: e.recipientAccountId, deviceId: e.recipientDeviceId });
    }
    return { serverTimestamp: now, duplicate: false, offline };
  }

  queued(
    conversationId: string,
    accountId: string,
    deviceId: number,
    limit = QUEUED_PAGE,
  ): { envelopes: Envelope[]; more: boolean } {
    const rows = this.sql
      .exec<CopyRow>(
        `SELECT id, message_id, sender_account, sender_device, type, content, server_ts FROM copies
         WHERE recipient_account = ? AND recipient_device = ? ORDER BY server_ts, rowid LIMIT ?`,
        accountId,
        deviceId,
        limit + 1,
      )
      .toArray();
    const envelopes = rows.slice(0, limit).map((r): Envelope => ({
      id: r.id,
      conversationId,
      messageId: r.message_id,
      senderAccountId: r.sender_account,
      senderDeviceId: r.sender_device,
      type: r.type as EnvelopeType,
      content: r.content,
      serverTimestamp: r.server_ts,
    }));
    return { envelopes, more: rows.length > limit };
  }

  // Deletes this device's delivery copies with these ids (others' copies and unknown ids are ignored).
  ack(accountId: string, deviceId: number, envelopeIds: string[]): void {
    if (envelopeIds.length === 0) return;
    this.sql.exec(
      `DELETE FROM copies WHERE recipient_account = ? AND recipient_device = ?
       AND id IN (SELECT value FROM json_each(?))`,
      accountId,
      deviceId,
      JSON.stringify(envelopeIds),
    );
  }

  forgetAccount(accountId: string): void {
    this.sql.exec("DELETE FROM copies WHERE recipient_account = ?", accountId);
    for (const ws of this.ctx.getWebSockets(accountTag(accountId))) this.close(ws, CLOSE_NOT_A_MEMBER, "not a member");
  }

  forgetDevice(accountId: string, deviceId: number): void {
    this.sql.exec("DELETE FROM copies WHERE recipient_account = ? AND recipient_device = ?", accountId, deviceId);
    for (const ws of this.ctx.getWebSockets(deviceTag(accountId, deviceId))) {
      this.close(ws, CLOSE_NOT_A_MEMBER, "device removed");
    }
  }

  // The account signed out everywhere: streams opened with a token from before `epoch` are closed. Their delivery
  // copies stay (the account's other phones fetch them once signed in again).
  revokeSessions(accountId: string, epoch: number): void {
    for (const ws of this.ctx.getWebSockets(accountTag(accountId))) {
      const info = ws.deserializeAttachment() as SocketInfo | null;
      if ((info?.sep ?? 0) < epoch) this.close(ws, CLOSE_TOKEN_EXPIRED, "session revoked");
    }
  }

  notify(conversationId: string, kind: RoomEventKind, removed: string[]): void {
    for (const account of removed) {
      for (const ws of this.ctx.getWebSockets(accountTag(account))) this.close(ws, CLOSE_NOT_A_MEMBER, "not a member");
    }
    const frame = JSON.stringify({ type: "event", event: { kind, conversationId } });
    for (const ws of this.ctx.getWebSockets()) this.trySend(ws, frame);
  }

  async purge(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) this.close(ws, CLOSE_NOT_A_MEMBER, "conversation deleted");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // Empty tables, in case this instance is called again before it is evicted.
    this.createTables();
  }

  pendingCount(): number {
    return this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM copies").one().n;
  }

  // WebSocket upgrade, forwarded by the Worker after it checked the token and membership.
  override async fetch(request: Request): Promise<Response> {
    const conversationId = request.headers.get("x-chat-conversation") ?? "";
    const accountId = request.headers.get("x-chat-account") ?? "";
    const deviceId = Number(request.headers.get("x-chat-device"));
    const exp = Number(request.headers.get("x-chat-exp"));
    const sep = Number(request.headers.get("x-chat-sep") ?? "0");
    if (!conversationId || !accountId || !Number.isInteger(deviceId) || !Number.isFinite(exp) || !Number.isInteger(sep))
      return new Response(null, { status: 400 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [deviceTag(accountId, deviceId), accountTag(accountId)]);
    const info: SocketInfo = { accountId, deviceId, exp, sep };
    server.serializeAttachment(info);
    await this.scheduleExpiry(exp);
    // What is queued for this device, right away (the oldest 1000; the rest via GET .../messages after acking);
    // later envelopes arrive live.
    for (const envelope of this.queued(conversationId, accountId, deviceId, 1000).envelopes) {
      this.trySend(server, JSON.stringify({ type: "envelope", envelope }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const info = ws.deserializeAttachment() as SocketInfo | null;
    if (!info) return;
    if (info.exp * 1000 <= Date.now()) {
      this.close(ws, CLOSE_TOKEN_EXPIRED, "token expired");
      return;
    }
    if (typeof message !== "string" || message.length > 64 * 1024) return;
    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }
    const f = frame as { type?: unknown; envelopeIds?: unknown };
    if (f.type === "typing") {
      this.relayTyping(info);
      return;
    }
    if (f.type === "ack" && Array.isArray(f.envelopeIds) && f.envelopeIds.length <= 100) {
      const ids = f.envelopeIds.filter((id): id is string => typeof id === "string");
      this.ack(info.accountId, info.deviceId, ids);
    }
  }

  // Ephemeral and content-free: sent to the other accounts' streams, never stored, never echoed to the sender's
  // account, dropped when the device already signalled within TYPING_MIN_INTERVAL_MS.
  private relayTyping(from: SocketInfo): void {
    const key = deviceTag(from.accountId, from.deviceId);
    const now = Date.now();
    const last = this.typingAt.get(key);
    if (last !== undefined && now - last < TYPING_MIN_INTERVAL_MS) return;
    this.typingAt.set(key, now);
    if (this.typingAt.size > 256) {
      for (const [k, at] of this.typingAt) if (now - at >= TYPING_MIN_INTERVAL_MS) this.typingAt.delete(k);
    }
    const frame = JSON.stringify({ type: "typing", accountId: from.accountId, deviceId: from.deviceId });
    for (const ws of this.ctx.getWebSockets()) {
      const info = ws.deserializeAttachment() as SocketInfo | null;
      if (info && info.accountId !== from.accountId) this.trySend(ws, frame);
    }
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    this.close(ws, code === 1005 ? 1000 : code, "bye");
  }

  // Closes streams whose chat token expired, then waits for the next expiry.
  override async alarm(): Promise<void> {
    const now = Date.now() / 1000;
    let next = Infinity;
    for (const ws of this.ctx.getWebSockets()) {
      const info = ws.deserializeAttachment() as SocketInfo | null;
      if (!info) continue;
      if (info.exp <= now) this.close(ws, CLOSE_TOKEN_EXPIRED, "token expired");
      else next = Math.min(next, info.exp);
    }
    if (next !== Infinity) await this.ctx.storage.setAlarm(next * 1000);
  }

  private async scheduleExpiry(exp: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > exp * 1000) await this.ctx.storage.setAlarm(exp * 1000);
  }

  private trySend(ws: WebSocket, frame: string): boolean {
    try {
      ws.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  private close(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }
}

function stub(env: Env, conversationId: string): DurableObjectStub<ConversationRoom> {
  // EU jurisdiction when deployed (workerd has no jurisdictions, so local dev and tests leave it unset). Never change
  // it for an environment that has data: the objects would get new ids.
  const namespace = env.ROOMS_JURISDICTION === "eu" ? env.ROOMS.jurisdiction("eu") : env.ROOMS;
  return namespace.get(namespace.idFromName(conversationId));
}

export function roomOf(env: Env, conversationId: string): DurableObjectStub<ConversationRoom> {
  return stub(env, conversationId);
}

// The conversation logic's view of the live side, backed by the conversation objects.
export function durableRooms(env: Env): Rooms {
  return {
    notify: (id, kind, removed) => roomOf(env, id).notify(id, kind, removed),
    forgetAccount: (id, account) => roomOf(env, id).forgetAccount(account),
    forgetDevice: (id, account, device) => roomOf(env, id).forgetDevice(account, device),
    revokeSessions: (id, account, epoch) => roomOf(env, id).revokeSessions(account, epoch),
    purge: (id) => roomOf(env, id).purge(),
  };
}
