// One Durable Object per account: the account's "events" WebSocket (GET /v1/events, hibernating while idle). A phone
// keeps one open next to its conversation streams and learns that it was added to a conversation (a new chat, or a
// parent becoming an observer), so it can load it and open its stream without a restart. Frames carry ids only and
// are never stored: a phone that was offline lists its conversations when it starts.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { CLOSE_TOKEN_EXPIRED } from "./room";

interface HubSocket {
  deviceId: number;
  // Chat token expiry, seconds since the epoch, and its session epoch (`sep`).
  exp: number;
  sep: number;
}

export class AccountHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  conversationAdded(conversationId: string): void {
    const frame = JSON.stringify({ type: "conversation_added", conversationId });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch {
        // closed already
      }
    }
  }

  // The account signed out everywhere: sockets opened with a token from before `epoch` are closed.
  revokeSessions(epoch: number): void {
    for (const ws of this.ctx.getWebSockets()) {
      const info = ws.deserializeAttachment() as HubSocket | null;
      if ((info?.sep ?? 0) < epoch) this.close(ws, CLOSE_TOKEN_EXPIRED, "session revoked");
    }
  }

  // WebSocket upgrade, forwarded by the Worker after it checked the token.
  override async fetch(request: Request): Promise<Response> {
    const deviceId = Number(request.headers.get("x-chat-device"));
    const exp = Number(request.headers.get("x-chat-exp"));
    const sep = Number(request.headers.get("x-chat-sep") ?? "0");
    if (!Number.isInteger(deviceId) || !Number.isFinite(exp) || !Number.isInteger(sep)) {
      return new Response(null, { status: 400 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const info: HubSocket = { deviceId, exp, sep };
    server.serializeAttachment(info);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > exp * 1000) await this.ctx.storage.setAlarm(exp * 1000);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Clients only send keep-alive pings (answered without waking the object); anything else is ignored.
  override webSocketMessage(): void {}

  override webSocketClose(ws: WebSocket, code: number): void {
    this.close(ws, code === 1005 ? 1000 : code, "bye");
  }

  // Closes sockets whose chat token expired, then waits for the next expiry.
  override async alarm(): Promise<void> {
    const now = Date.now() / 1000;
    let next = Infinity;
    for (const ws of this.ctx.getWebSockets()) {
      const info = ws.deserializeAttachment() as HubSocket | null;
      if (!info) continue;
      if (info.exp <= now) this.close(ws, CLOSE_TOKEN_EXPIRED, "token expired");
      else next = Math.min(next, info.exp);
    }
    if (next !== Infinity) await this.ctx.storage.setAlarm(next * 1000);
  }

  private close(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }
}

export function hubOf(env: Env, accountId: string): DurableObjectStub<AccountHub> {
  // Same jurisdiction rule as the conversation objects (src/room.ts).
  const namespace = env.ROOMS_JURISDICTION === "eu" ? env.ACCOUNTS.jurisdiction("eu") : env.ACCOUNTS;
  return namespace.get(namespace.idFromName(accountId));
}
