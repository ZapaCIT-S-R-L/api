// api #81: after a logout-all at the account API, the chat service revokes the account's chat tokens from before
// the new session epoch. Calls asks it on every request, before every relayed key, and once a minute for every
// participant of a live call, so a lost phone is out of calls within a minute, not when its token expires.
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVALIDATE_MS } from "../../src/call-room";
import { resetJwksCache } from "../../src/jwks";
import { chatDownForAccount, errorCode, phone, revokeSessions } from "./calls-helpers";
import {
  fakeRealtime,
  makeIssuer,
  stubFetch,
  uniqueAccount,
  type CallView,
  type FakeRealtime,
  type TestIssuer,
} from "./helpers";

let issuer: TestIssuer;
let realtime: FakeRealtime;
let n = 0;
const conversation = () => `conv-r-${Date.now().toString(36)}-${++n}`;

beforeEach(async () => {
  resetJwksCache();
  issuer = await makeIssuer();
  realtime = fakeRealtime(stubFetch([issuer]));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const stub = (callId: string) => env.CALL.get(env.CALL.idFromName(callId));

async function advance(callId: string, ms: number) {
  vi.useFakeTimers({ now: Date.now() + ms, toFake: ["Date"] });
  await runDurableObjectAlarm(stub(callId));
}

const blob = btoa(String.fromCharCode(...new Uint8Array(64).fill(7)));

describe("revoked chat tokens", () => {
  it("every request with a token from before the account's session epoch → 401 invalid_token", async () => {
    const conv = conversation();
    const dad = await phone(issuer, uniqueAccount(), 1, [conv], "parent", { sep: 1 });
    const { call } = await dad.create(conv);
    await revokeSessions(dad.accountId, 2);
    for (const [method, path] of [
      ["GET", `/v1/calls/${call.callId}`],
      ["POST", `/v1/calls/${call.callId}/join`],
      ["POST", `/v1/calls/${call.callId}/leave`],
      ["GET", `/v1/calls?conversationId=${conv}`],
    ] as const) {
      const res = await dad.request(method, path);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(await errorCode(res)).toBe("invalid_token");
    }
    const create = await dad.request("POST", "/v1/calls", { conversationId: conv });
    expect(create.status).toBe(401);
    // A token from the new epoch (the parent signed in again) works; other accounts are not affected.
    const again = await phone(issuer, dad.accountId, 2, [conv], "parent", { sep: 2 });
    expect((await again.request("GET", `/v1/calls/${call.callId}`)).status).toBe(200);
    const mum = await phone(issuer, uniqueAccount(), 1, [conv]);
    expect((await mum.request("GET", `/v1/calls/${call.callId}`)).status).toBe(200);
  });

  it("a token without sep counts as epoch 0", async () => {
    const conv = conversation();
    const dad = await phone(issuer, uniqueAccount(), 1, [conv]);
    const { call } = await dad.create(conv);
    await revokeSessions(dad.accountId, 1);
    expect((await dad.request("GET", `/v1/calls/${call.callId}`)).status).toBe(401);
  });

  it("the chat service failing the check → 503, never allowed", async () => {
    const conv = conversation();
    const dad = await phone(issuer, uniqueAccount(), 1, [conv], "parent", { sep: 5 });
    const { call } = await dad.create(conv);
    await chatDownForAccount(dad.accountId);
    const res = await dad.request("GET", `/v1/calls/${call.callId}`);
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe("chat_unavailable");
  });

  it("a revoked phone that relays a key is dropped from the call and its socket closed (4401)", async () => {
    const conv = conversation();
    const dad = await phone(issuer, uniqueAccount(), 1, [conv], "parent", { sep: 1 });
    const mum = await phone(issuer, uniqueAccount(), 1, [conv], "parent", { sep: 1 });
    const { call } = await dad.create(conv);
    expect((await mum.join(call.callId)).status).toBe(200);
    const dadEvents = await dad.events(call.callId);
    const mumEvents = await mum.events(call.callId);
    await dadEvents.next("roster");
    await mumEvents.next("roster");
    const closes: number[] = [];
    dadEvents.ws.addEventListener("close", (e) => {
      closes.push(e.code);
    });

    await revokeSessions(dad.accountId, 2);
    dadEvents.send({
      type: "keys",
      epoch: 2,
      envelopes: [{ toAccount: mum.accountId, toDevice: 1, blob }],
    });
    expect(await mumEvents.next("left")).toMatchObject({ accountId: dad.accountId, deviceId: 1, reason: "revoked" });
    const roster = (await mumEvents.next("roster")).call as CallView;
    expect(roster.participants.map((p) => p.accountId)).toEqual([mum.accountId]);
    await dadEvents.next("__closed");
    expect(closes).toEqual([4401]);
    // Mum never got the key the revoked phone tried to relay.
    expect(mumEvents.messages.some((m) => m.type === "key")).toBe(false);
    mumEvents.close();
  });

  it("a quiet revoked phone is dropped at the next minutely check, with a new call key epoch", async () => {
    const conv = conversation();
    const dad = await phone(issuer, uniqueAccount(), 1, [conv], "parent", { sep: 1 });
    const mum = await phone(issuer, uniqueAccount(), 1, [conv], "parent", { sep: 1 });
    const { call } = await dad.create(conv);
    expect((await mum.join(call.callId)).status).toBe(200);
    const dadEvents = await dad.events(call.callId);
    const mumEvents = await mum.events(call.callId);
    await dadEvents.next("roster");
    await mumEvents.next("roster");
    const closes: number[] = [];
    dadEvents.ws.addEventListener("close", (e) => {
      closes.push(e.code);
    });

    await revokeSessions(dad.accountId, 2);
    // Nothing happens before the check is due.
    await advance(call.callId, REVALIDATE_MS / 2);
    const before = await mum.request("GET", `/v1/calls/${call.callId}`).then((r) => r.json<CallView>());
    expect(before.participants).toHaveLength(2);
    await advance(call.callId, REVALIDATE_MS);
    expect(await mumEvents.next("left")).toMatchObject({ accountId: dad.accountId, reason: "revoked", epoch: 3 });
    await dadEvents.next("__closed");
    expect(closes).toEqual([4401]);
    const view = await mum.request("GET", `/v1/calls/${call.callId}`).then((r) => r.json<CallView>());
    expect(view.participants.map((p) => p.accountId)).toEqual([mum.accountId]);
    expect(view.state).toBe("active");
    mumEvents.close();
  });

  it("a revoked phone's SFU session is closed (its tracks, by force), the others' are kept", async () => {
    const conv = conversation();
    const dad = await phone(issuer, uniqueAccount(), 1, [conv], "parent", { sep: 1 });
    const mum = await phone(issuer, uniqueAccount(), 1, [conv], "parent", { sep: 1 });
    const { call } = await dad.create(conv);
    expect((await mum.join(call.callId)).status).toBe(200);
    const sdp = { type: "offer", sdp: "v=0 fake offer" };
    const sessions: string[] = [];
    for (const [p, track] of [
      [dad, "audio-dad"],
      [mum, "audio-mum"],
    ] as const) {
      const res = await p.request("POST", `/v1/calls/${call.callId}/sessions`, { sessionDescription: sdp });
      expect(res.status).toBe(201);
      const { sessionId } = await res.json<{ sessionId: string }>();
      sessions.push(sessionId);
      const pub = await p.request("POST", `/v1/calls/${call.callId}/sessions/${sessionId}/tracks/new`, {
        sessionDescription: sdp,
        tracks: [{ location: "local", trackName: track }],
      });
      expect(pub.status).toBe(200);
    }
    const [dadSession, mumSession] = sessions as [string, string];

    await revokeSessions(dad.accountId, 2);
    await advance(call.callId, REVALIDATE_MS + 1);
    const closeCalls = realtime.requests.filter((r) => r.method === "PUT" && r.path.endsWith("/tracks/close"));
    expect(closeCalls).toEqual([
      expect.objectContaining({
        path: `/apps/test-app-id/sessions/${dadSession}/tracks/close`,
        body: { tracks: [{ mid: "0" }], force: true },
      }),
    ]);
    expect(realtime.tracks.get(dadSession)).toEqual([]);
    expect(realtime.tracks.get(mumSession)).toHaveLength(1);
  });

  it("when every participant is revoked the call ends", async () => {
    const conv = conversation();
    const dad = await phone(issuer, uniqueAccount(), 1, [conv], "parent", { sep: 1 });
    const mum = await phone(issuer, uniqueAccount(), 1, [conv], "parent", { sep: 1 });
    const grandma = await phone(issuer, uniqueAccount(), 1, [conv]);
    const { call } = await dad.create(conv);
    expect((await mum.join(call.callId)).status).toBe(200);
    await revokeSessions(dad.accountId, 2);
    await revokeSessions(mum.accountId, 2);
    await advance(call.callId, REVALIDATE_MS + 1);
    const view = await grandma.request("GET", `/v1/calls/${call.callId}`).then((r) => r.json<CallView>());
    expect(view.state).toBe("ended");
    expect(view.endReason).toBe("disconnected");
  });
});
