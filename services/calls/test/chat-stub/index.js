// Tests only: a stand-in for the chat service's ChatMembership entrypoint (services/chat/src/rpc.ts on the
// chat-membership-rpc branch), which the calls Worker reaches through its CHAT service binding. It is never deployed.
//
// - Worker tests (vitest.config.ts): an auxiliary Miniflare Worker; the tests set members through its own fetch
//   (the CHAT_STUB binding): PUT /members {conversationId, accountId, role, deviceId}, DELETE /members
//   {conversationId, accountId}, PUT /down {conversationId} (chat answers with an error for that conversation),
//   PUT /revoked {accountId, epoch} (the account signed out everywhere: tokens with sep < epoch are revoked),
//   PUT /down-account {accountId} (the revocation check fails for that account). OldChatMembership is the chat
//   Worker from before revoked() existed (OLD_CHAT binding).
// - e2e (scripts/check.sh: wrangler dev with a second config, wrangler.jsonc here): the members live in the fake
//   server of test/e2e/fakes.ts, at FAKE_CHAT_URL, which the Node tests fill over HTTP.
import { WorkerEntrypoint } from "cloudflare:workers";

// conversationId → Map(accountId → { role, devices })
const conversations = new Map();
const down = new Set();
// accountId → session epoch below which chat tokens are revoked (PUT /revoked); accounts the chat service fails for.
const epochs = new Map();
const downAccounts = new Set();

async function membersOf(env, conversationId) {
  if (env.FAKE_CHAT_URL) {
    const res = await fetch(`${env.FAKE_CHAT_URL}/conversations/${encodeURIComponent(conversationId)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`fake chat answered ${res.status}`);
    return res.json();
  }
  if (down.has(conversationId)) throw new Error("chat is down (test)");
  const members = conversations.get(conversationId);
  if (!members) return null;
  return [...members.entries()].map(([accountId, m]) => ({ accountId, role: m.role, devices: [...m.devices] }));
}

export class ChatMembership extends WorkerEntrypoint {
  async member(conversationId, accountId) {
    const members = await membersOf(this.env, conversationId);
    if (members === null) return null;
    if (!members.some((m) => m.accountId === accountId)) return { member: false, members: [] };
    return { member: true, members };
  }

  // services/chat/src/rpc.ts: true when the token's session epoch is below the account's (a logout-all happened).
  async revoked(accountId, sep) {
    if (this.env.FAKE_CHAT_URL) return false;
    if (downAccounts.has(accountId)) throw new Error("chat is down (test)");
    return sep < (epochs.get(accountId) ?? 0);
  }
}

// A chat Worker from before api #81: ChatMembership without revoked(). The tests reach it as OLD_CHAT
// (vitest.config.ts) to check calls deployed before chat refuses with a retryable 503 and never lets a token through.
export class OldChatMembership extends WorkerEntrypoint {
  async member(conversationId, accountId) {
    return new ChatMembership(this.ctx, this.env).member(conversationId, accountId);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.json();
    if (url.pathname === "/members" && request.method === "PUT") {
      const members = conversations.get(body.conversationId) ?? new Map();
      conversations.set(body.conversationId, members);
      const m = members.get(body.accountId) ?? { role: body.role, devices: [] };
      if (!m.devices.includes(body.deviceId)) m.devices.push(body.deviceId);
      members.set(body.accountId, m);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/members" && request.method === "DELETE") {
      conversations.get(body.conversationId)?.delete(body.accountId);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/down" && request.method === "PUT") {
      down.add(body.conversationId);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/revoked" && request.method === "PUT") {
      epochs.set(body.accountId, body.epoch);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/down-account" && request.method === "PUT") {
      downAccounts.add(body.accountId);
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  },
};
