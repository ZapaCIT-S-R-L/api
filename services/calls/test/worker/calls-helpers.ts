// A phone in the tests: a chat token for one account and device, and the calls API over the Worker's fetch. The
// chat service's membership answers come from the stub Worker in test/chat-stub (the CHAT service binding).
import { env, exports } from "cloudflare:workers";
import { bearer, chatClaims, type CallView, type ErrorBody, type TestIssuer } from "./helpers";

export interface Phone {
  accountId: string;
  deviceId: number;
  token: string;
  request(method: string, path: string, body?: unknown): Promise<Response>;
  create(conversationId?: string): Promise<{ call: CallView; iceServers: unknown[] }>;
  join(callId: string): Promise<Response>;
  events(callId: string): Promise<Socket>;
}

export interface Socket {
  ws: WebSocket;
  messages: Record<string, unknown>[];
  next(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  send(message: unknown): void;
  close(): void;
}

async function chatStub(method: string, path: string, body: unknown): Promise<void> {
  const res = await env.CHAT_STUB.fetch(`https://chat-stub${path}`, { method, body: JSON.stringify(body) });
  if (res.status !== 204) throw new Error(`chat stub answered ${res.status}`);
}

export type StubRole = "parent" | "kid" | "observer";

// What the chat service knows: this device of this account is a member of the conversation ("observer": a kid's
// parent reading the chat, not a member for calls).
export function addMember(
  conversationId: string,
  accountId: string,
  deviceId = 1,
  role: StubRole = "parent",
): Promise<void> {
  return chatStub("PUT", "/members", { conversationId, accountId, deviceId, role });
}

// The account left the conversation (left the family, connection removed...).
export function removeMember(conversationId: string, accountId: string): Promise<void> {
  return chatStub("DELETE", "/members", { conversationId, accountId });
}

// The chat service fails for this conversation (an outage).
export function chatDown(conversationId: string): Promise<void> {
  return chatStub("PUT", "/down", { conversationId });
}

// A phone whose account the chat service lists as a member of `conversations` (unless `member` is false). Its
// token's `conv` claim holds membership scopes, as the account API issues it, not the conversation ids.
export async function phone(
  issuer: TestIssuer,
  accountId: string,
  deviceId = 1,
  conversations = ["conv-1"],
  role: StubRole = "parent",
  { member = true, conv }: { member?: boolean; conv?: string[] } = {},
): Promise<Phone> {
  if (member) for (const c of conversations) await addMember(c, accountId, deviceId, role);
  const token = await issuer.sign(
    // An observer is a parent account; "observer" is its role in the conversation, not in the token.
    chatClaims({
      sub: accountId,
      dev: deviceId,
      role: role === "observer" ? "parent" : role,
      ...(conv === undefined ? {} : { conv }),
    }),
  );
  const request = (method: string, path: string, body?: unknown) =>
    exports.default.fetch(
      new Request(`https://calls.test${path}`, {
        method,
        headers: { ...bearer(token), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return {
    accountId,
    deviceId,
    token,
    request,
    async create(conversationId = conversations[0] ?? "conv-1") {
      const res = await request("POST", "/v1/calls", { conversationId });
      if (res.status !== 201) throw new Error(`create answered ${res.status}: ${await res.text()}`);
      return res.json();
    },
    join: (callId) => request("POST", `/v1/calls/${callId}/join`),
    async events(callId) {
      const res = await exports.default.fetch(
        new Request(`https://calls.test/v1/calls/${callId}/events`, {
          headers: { ...bearer(token), upgrade: "websocket" },
        }),
      );
      if (res.status !== 101 || !res.webSocket) throw new Error(`events answered ${res.status}: ${await res.text()}`);
      return socket(res.webSocket);
    },
  };
}

function socket(ws: WebSocket): Socket {
  const messages: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  ws.accept();
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    for (const wake of waiters.splice(0)) wake();
  });
  ws.addEventListener("close", () => {
    messages.push({ type: "__closed" });
    for (const wake of waiters.splice(0)) wake();
  });
  let read = 0;
  return {
    ws,
    messages,
    // The next message of this type after the ones already consumed.
    async next(type, timeoutMs = 2000) {
      // Counted in 50 ms waits, not Date.now(): some tests fake the clock.
      for (let waited = 0; ; waited += 50) {
        const index = messages.findIndex((m, i) => i >= read && m.type === type);
        if (index >= 0) {
          read = index + 1;
          return messages[index] as Record<string, unknown>;
        }
        if (waited > timeoutMs) throw new Error(`no ${type} message; got ${JSON.stringify(messages.slice(read))}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
    },
    send: (message) => {
      ws.send(JSON.stringify(message));
    },
    close: () => {
      ws.close(1000, "bye");
    },
  };
}

export async function errorCode(res: Response): Promise<string> {
  return (await res.json<ErrorBody>()).error.code;
}
