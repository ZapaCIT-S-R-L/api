// Who may start, see and join a call: the chat service decides (its ChatMembership entrypoint, over the CHAT
// service binding), not the chat token. The token's `conv` claim holds membership scopes (family:<id>,
// connection:<id>) and is accepted but never used to authorize.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetJwksCache } from "../../src/jwks";
import { usePushProvider, type PushProvider, type RingingCall } from "../../src/push";
import { addMember, chatDown, errorCode, phone, removeMember } from "./calls-helpers";
import { fakeRealtime, makeIssuer, stubFetch, uniqueAccount, type CallView, type TestIssuer } from "./helpers";

let issuer: TestIssuer;
const rings: (RingingCall & { event: string })[] = [];
const push: PushProvider = {
  ring: (call) => {
    rings.push({ ...call, event: "ring" });
    return Promise.resolve();
  },
  cancel: (call) => {
    rings.push({ ...call, event: "cancel" });
    return Promise.resolve();
  },
};

let n = 0;
// A conversation only this test uses (the chat stub keeps its members for the whole run).
const conversation = () => `conv-m-${Date.now().toString(36)}-${++n}`;

beforeEach(async () => {
  resetJwksCache();
  issuer = await makeIssuer();
  fakeRealtime(stubFetch([issuer]));
  rings.length = 0;
  usePushProvider(push);
});

afterEach(() => {
  usePushProvider(null);
  vi.restoreAllMocks();
});

describe("starting a call", () => {
  it("a member starts a call; the token's conv claim holds scopes, not the conversation", async () => {
    const conv = conversation();
    const dad = await phone(issuer, uniqueAccount(), 1, [conv], "parent", { conv: ["family:f1", "connection:k1"] });
    const res = await dad.request("POST", "/v1/calls", { conversationId: conv });
    expect(res.status).toBe(201);
    expect((await res.json<{ call: CallView }>()).call).toMatchObject({ conversationId: conv, state: "ringing" });
  });

  it("not a member per the chat service → 403, even when the token's conv claim lists the conversation", async () => {
    const conv = conversation();
    const mum = await phone(issuer, uniqueAccount(), 1, [conv]);
    const stranger = await phone(issuer, uniqueAccount(), 1, [conv], "parent", { member: false, conv: [conv] });
    const res = await stranger.request("POST", "/v1/calls", { conversationId: conv });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("conversation_not_allowed");
    expect((await mum.request("POST", "/v1/calls", { conversationId: conv })).status).toBe(201);
  });

  it("a conversation the chat service doesn't know → 403", async () => {
    const dad = await phone(issuer, uniqueAccount(), 1, []);
    const res = await dad.request("POST", "/v1/calls", { conversationId: "c_unknownunknownunknown" });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("conversation_not_allowed");
  });

  it("rings every device of the other members (from the chat service), not the caller's own", async () => {
    const conv = conversation();
    const dad = await phone(issuer, uniqueAccount(), 1, [conv]);
    await addMember(conv, dad.accountId, 2);
    const mum = await phone(issuer, uniqueAccount(), 1, [conv]);
    await addMember(conv, mum.accountId, 5);
    const kid = await phone(issuer, uniqueAccount(), 3, [conv], "kid");
    const { call } = await dad.create(conv);
    const to = [
      { accountId: mum.accountId, deviceId: 1 },
      { accountId: mum.accountId, deviceId: 5 },
      { accountId: kid.accountId, deviceId: 3 },
    ];
    expect(rings).toEqual([{ callId: call.callId, conversationId: conv, from: dad.accountId, to, event: "ring" }]);
    // Answered: the same devices stop ringing.
    expect((await kid.join(call.callId)).status).toBe(200);
    expect(rings[1]).toEqual({ callId: call.callId, conversationId: conv, from: dad.accountId, to, event: "cancel" });
  });

  it("the chat service unreachable → 503 chat_unavailable, never a call", async () => {
    const conv = conversation();
    const dad = await phone(issuer, uniqueAccount(), 1, [conv]);
    await chatDown(conv);
    const res = await dad.request("POST", "/v1/calls", { conversationId: conv });
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe("chat_unavailable");
    expect(rings).toEqual([]);
  });
});

describe("joining and seeing a call", () => {
  it("a member joins; the roster keeps integer device ids and the server's epoch", async () => {
    const conv = conversation();
    const dad = await phone(issuer, uniqueAccount(), 1, [conv]);
    const kid = await phone(issuer, uniqueAccount(), 2, [conv], "kid");
    const { call } = await dad.create(conv);
    const res = await kid.join(call.callId);
    expect(res.status).toBe(200);
    const view = (await res.json<{ call: CallView }>()).call;
    expect(view.epoch).toBe(2);
    expect(view.participants.map((p) => [p.accountId, p.deviceId])).toEqual([
      [dad.accountId, 1],
      [kid.accountId, 2],
    ]);
  });

  it("a non-member can't see, join, decline or open the events of the call → 404", async () => {
    const conv = conversation();
    const dad = await phone(issuer, uniqueAccount(), 1, [conv]);
    const stranger = await phone(issuer, uniqueAccount(), 1, [], "parent", { conv: [conv] });
    const { call } = await dad.create(conv);
    for (const [method, path] of [
      ["GET", `/v1/calls/${call.callId}`],
      ["POST", `/v1/calls/${call.callId}/join`],
      ["POST", `/v1/calls/${call.callId}/decline`],
    ] as const) {
      expect((await stranger.request(method, path)).status, `${method} ${path}`).toBe(404);
    }
    await expect(stranger.events(call.callId)).rejects.toThrow(/answered 404/);
  });

  it("a member removed from the conversation mid-call can't rejoin, see it or set up audio", async () => {
    const conv = conversation();
    const dad = await phone(issuer, uniqueAccount(), 1, [conv]);
    const mum = await phone(issuer, uniqueAccount(), 1, [conv]);
    const kid = await phone(issuer, uniqueAccount(), 2, [conv], "kid");
    const { call } = await dad.create(conv);
    expect((await mum.join(call.callId)).status).toBe(200);
    expect((await kid.join(call.callId)).status).toBe(200);
    expect((await mum.request("POST", `/v1/calls/${call.callId}/leave`)).status).toBe(204);

    await removeMember(conv, mum.accountId);
    const rejoin = await mum.join(call.callId);
    expect(rejoin.status).toBe(404);
    expect((await mum.request("GET", `/v1/calls/${call.callId}`)).status).toBe(404);
    expect((await mum.request("POST", `/v1/calls/${call.callId}/sessions`, {})).status).toBe(404);
    await expect(mum.events(call.callId)).rejects.toThrow(/answered 404/);
    // The others carry on.
    const view = await (await dad.request("GET", `/v1/calls/${call.callId}`)).json<CallView>();
    expect(view.participants.map((p) => p.accountId)).toEqual([dad.accountId, kid.accountId]);
  });

  it("removed while still in the call: no new SFU session or tracks for them", async () => {
    const conv = conversation();
    const dad = await phone(issuer, uniqueAccount(), 1, [conv]);
    const mum = await phone(issuer, uniqueAccount(), 1, [conv]);
    const { call } = await dad.create(conv);
    await mum.join(call.callId);
    await removeMember(conv, mum.accountId);
    expect((await mum.request("POST", `/v1/calls/${call.callId}/sessions`, {})).status).toBe(404);
  });

  it("the chat service unreachable on join → 503 chat_unavailable", async () => {
    const conv = conversation();
    const dad = await phone(issuer, uniqueAccount(), 1, [conv]);
    const mum = await phone(issuer, uniqueAccount(), 1, [conv]);
    const { call } = await dad.create(conv);
    await chatDown(conv);
    const res = await mum.join(call.callId);
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe("chat_unavailable");
  });
});

describe("the call log", () => {
  it("only for a member of the conversation (the chat service decides)", async () => {
    const conv = conversation();
    const dad = await phone(issuer, uniqueAccount(), 1, [conv]);
    await dad.create(conv);
    expect((await dad.request("GET", `/v1/calls?conversationId=${conv}`)).status).toBe(200);
    const stranger = await phone(issuer, uniqueAccount(), 1, [], "parent", { conv: [conv] });
    const res = await stranger.request("GET", `/v1/calls?conversationId=${conv}`);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("conversation_not_allowed");
  });
});
