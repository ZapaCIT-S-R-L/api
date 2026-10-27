// The calls API: create, join, leave, decline, the roster, the ring timeout, the participant cap and the call log.
import { createScheduledController, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { resetJwksCache } from "../../src/jwks";
import { usePushProvider, type PushProvider } from "../../src/push";
import { errorCode, phone } from "./calls-helpers";
import {
  bearer,
  chatClaims,
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
const rings: { callId: string; conversationId: string; event: string }[] = [];
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

beforeEach(async () => {
  resetJwksCache();
  issuer = await makeIssuer();
  realtime = fakeRealtime(stubFetch([issuer]));
  rings.length = 0;
  usePushProvider(push);
});

afterEach(() => {
  usePushProvider(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const stub = (callId: string) => env.CALL.get(env.CALL.idFromName(callId));

async function row(callId: string) {
  return env.DB.prepare("SELECT * FROM calls WHERE id = ?").bind(callId).first();
}

// Moves the clock forward and runs the call's alarm, as if that much time passed.
async function advance(callId: string, seconds: number) {
  vi.useFakeTimers({ now: Date.now() + seconds * 1000, toFake: ["Date"] });
  await runDurableObjectAlarm(stub(callId));
}

describe("POST /v1/calls", () => {
  it("starts a call: the caller is in it, the others are rung, ICE servers come from TURN", async () => {
    const dad = await phone(issuer, uniqueAccount());
    const res = await dad.request("POST", "/v1/calls", { conversationId: "conv-1" });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json<{
      call: CallView;
      iceServers: { urls: string[]; username?: string }[];
      limits: Record<string, number>;
    }>();
    expect(body.call.callId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.call).toMatchObject({ conversationId: "conv-1", state: "ringing", epoch: 1, endReason: null });
    expect(body.call.participants).toEqual([
      expect.objectContaining({ accountId: dad.accountId, deviceId: 1, role: "parent", tracks: [] }),
    ]);
    expect(body.call.keyLeader).toEqual({ accountId: dad.accountId, deviceId: 1 });
    expect(body.iceServers[1]?.username).toMatch(/^user-/);
    expect(body.limits).toEqual({ maxParticipants: 8, ringTimeoutSeconds: 45, maxDurationSeconds: 7200 });
    expect(rings).toEqual([{ callId: body.call.callId, conversationId: "conv-1", from: dad.accountId, event: "ring" }]);

    const turn = realtime.requests.find((r) => r.path.startsWith("/turn/"));
    expect(turn?.path).toBe("/turn/keys/test-turn-key/credentials/generate-ice-servers");
    expect(turn?.auth).toBe("Bearer test-turn-token");
    expect(turn?.body).toEqual({ ttl: 3600 });

    expect(await row(body.call.callId)).toMatchObject({
      conversation_id: "conv-1",
      created_by_account: dad.accountId,
      created_by_device: 1,
      ended_at: null,
      peak_participants: 1,
    });
  });

  it("a conversation that is not in the token → 403 conversation_not_allowed", async () => {
    const dad = await phone(issuer, uniqueAccount(), 1, ["conv-1"]);
    const res = await dad.request("POST", "/v1/calls", { conversationId: "conv-other" });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("conversation_not_allowed");
  });

  it("a call already running in the conversation → 409 call_in_progress with its id", async () => {
    const dad = await phone(issuer, uniqueAccount(), 1, ["conv-busy"]);
    const mum = await phone(issuer, uniqueAccount(), 1, ["conv-busy"]);
    const { call } = await dad.create();
    const res = await mum.request("POST", "/v1/calls", { conversationId: "conv-busy" });
    expect(res.status).toBe(409);
    const body = await res.json<{ error: { code: string }; callId: string }>();
    expect(body.error.code).toBe("call_in_progress");
    expect(body.callId).toBe(call.callId);
  });

  it("TURN down → still starts, with Cloudflare's STUN only", async () => {
    realtime.turnDown = true;
    const dad = await phone(issuer, uniqueAccount());
    const { iceServers } = await dad.create();
    expect(iceServers).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }]);
  });

  it("bad bodies → 400; no token → 401; wrong method → 405", async () => {
    const dad = await phone(issuer, uniqueAccount());
    for (const body of [{}, { conversationId: "" }, { conversationId: 5 }, { conversationId: "conv-1", extra: 1 }]) {
      expect((await dad.request("POST", "/v1/calls", body)).status).toBe(400);
    }
    const anonymous = await exports.default.fetch(
      new Request("https://calls.test/v1/calls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: "conv-1" }),
      }),
    );
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe("Bearer");
    expect((await dad.request("DELETE", "/v1/calls")).status).toBe(405);
  });

  it("a token for chat only (wrong audience) → 401 invalid_token", async () => {
    const token = await issuer.sign(chatClaims({ aud: ["chat.localhost"] }));
    const res = await exports.default.fetch(
      new Request("https://calls.test/v1/calls?conversationId=conv-1", { headers: bearer(token) }),
    );
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("invalid_token");
  });

  it("the account API's keys unreachable → 503, not 401", async () => {
    const dad = await phone(issuer, uniqueAccount());
    resetJwksCache();
    stubFetch([issuer]).failJwks = true;
    const res = await dad.request("POST", "/v1/calls", { conversationId: "conv-1" });
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe("keys_unavailable");
  });

  it("rate limited per account: the 6th call a minute → 429", async () => {
    const dad = await phone(issuer, uniqueAccount(), 1, ["c1", "c2", "c3", "c4", "c5", "c6"]);
    for (const conv of ["c1", "c2", "c3", "c4", "c5"]) await dad.create(conv);
    const res = await dad.request("POST", "/v1/calls", { conversationId: "c6" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });
});

describe("join, leave, decline and the roster", () => {
  it("a member joins: the call is answered, the key epoch goes up, the roster lists both", async () => {
    const dad = await phone(issuer, uniqueAccount());
    const kid = await phone(issuer, uniqueAccount(), 2, ["conv-1"], "kid");
    const { call } = await dad.create();
    const res = await kid.join(call.callId);
    expect(res.status).toBe(200);
    const body = await res.json<{ call: CallView; iceServers: unknown[] }>();
    expect(body.call.state).toBe("active");
    expect(body.call.epoch).toBe(2);
    expect(body.call.participants.map((p) => [p.accountId, p.deviceId, p.role])).toEqual([
      [dad.accountId, 1, "parent"],
      [kid.accountId, 2, "kid"],
    ]);
    expect(body.call.keyLeader).toEqual({ accountId: dad.accountId, deviceId: 1 });
    expect(body.iceServers.length).toBeGreaterThan(0);
    expect(await row(call.callId)).toMatchObject({ peak_participants: 2 });
    expect((await row(call.callId))?.answered_at).not.toBeNull();
  });

  it("joining twice from the same device changes nothing", async () => {
    const dad = await phone(issuer, uniqueAccount());
    const mum = await phone(issuer, uniqueAccount());
    const { call } = await dad.create();
    await mum.join(call.callId);
    const again = await (await mum.join(call.callId)).json<{ call: CallView }>();
    expect(again.call.epoch).toBe(2);
    expect(again.call.participants).toHaveLength(2);
  });

  it("a member of another conversation can't see, join or decline it → 404", async () => {
    const dad = await phone(issuer, uniqueAccount());
    const stranger = await phone(issuer, uniqueAccount(), 1, ["conv-2"]);
    const { call } = await dad.create();
    for (const [method, path] of [
      ["GET", `/v1/calls/${call.callId}`],
      ["POST", `/v1/calls/${call.callId}/join`],
      ["POST", `/v1/calls/${call.callId}/decline`],
    ] as const) {
      const res = await stranger.request(method, path);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it("an unknown or malformed call id → 404", async () => {
    const dad = await phone(issuer, uniqueAccount());
    expect((await dad.request("GET", "/v1/calls/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await dad.request("GET", "/v1/calls/not-a-call")).status).toBe(404);
  });

  it("the 9th device → 409 call_full (at most 8 participants)", async () => {
    const dad = await phone(issuer, uniqueAccount());
    const { call } = await dad.create();
    for (let i = 2; i <= 8; i++) {
      const member = await phone(issuer, uniqueAccount(), i);
      expect((await member.join(call.callId)).status).toBe(200);
    }
    const ninth = await phone(issuer, uniqueAccount(), 9);
    const res = await ninth.join(call.callId);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("call_full");
  });

  it("leaving: the epoch goes up, the leader moves on; the last one out ends the call", async () => {
    const dad = await phone(issuer, uniqueAccount());
    const mum = await phone(issuer, uniqueAccount());
    const { call } = await dad.create();
    await mum.join(call.callId);
    expect((await dad.request("POST", `/v1/calls/${call.callId}/leave`)).status).toBe(204);
    const view = await (await mum.request("GET", `/v1/calls/${call.callId}`)).json<CallView>();
    expect(view.epoch).toBe(3);
    expect(view.keyLeader).toEqual({ accountId: mum.accountId, deviceId: 1 });
    expect(view.participants.map((p) => p.accountId)).toEqual([mum.accountId]);

    await mum.request("POST", `/v1/calls/${call.callId}/leave`);
    const ended = await (await mum.request("GET", `/v1/calls/${call.callId}`)).json<CallView>();
    expect(ended).toMatchObject({ state: "ended", endReason: "hung_up", participants: [] });
    expect(await row(call.callId)).toMatchObject({ end_reason: "hung_up" });
    const rejoin = await mum.join(call.callId);
    expect(rejoin.status).toBe(410);
    expect(await errorCode(rejoin)).toBe("call_ended");
  });

  it("decline: the others hear about it; if the caller then hangs up unanswered, the call ended as declined", async () => {
    const dad = await phone(issuer, uniqueAccount());
    const mum = await phone(issuer, uniqueAccount());
    const { call } = await dad.create();
    const events = await dad.events(call.callId);
    await events.next("roster");
    expect((await mum.request("POST", `/v1/calls/${call.callId}/decline`)).status).toBe(204);
    expect(await events.next("declined")).toMatchObject({ accountId: mum.accountId });
    await dad.request("POST", `/v1/calls/${call.callId}/leave`);
    expect(await row(call.callId)).toMatchObject({ end_reason: "declined" });
    expect(rings.map((r) => r.event)).toEqual(["ring", "cancel"]);
    events.close();
  });

  it("nobody answers in 45 s → ended no_answer, the ring is cancelled", async () => {
    const dad = await phone(issuer, uniqueAccount());
    const { call } = await dad.create();
    const events = await dad.events(call.callId);
    await advance(call.callId, 46);
    expect(await events.next("ended")).toMatchObject({ reason: "no_answer" });
    expect(await row(call.callId)).toMatchObject({ end_reason: "no_answer" });
    expect(rings.map((r) => r.event)).toEqual(["ring", "cancel"]);
  });

  it("an answered call doesn't time out at 45 s, but ends at the maximum duration", async () => {
    const dad = await phone(issuer, uniqueAccount());
    const mum = await phone(issuer, uniqueAccount());
    const { call } = await dad.create();
    await mum.join(call.callId);
    const a = await dad.events(call.callId);
    const b = await mum.events(call.callId);
    await advance(call.callId, 46);
    expect((await (await dad.request("GET", `/v1/calls/${call.callId}`)).json<CallView>()).state).toBe("active");
    await advance(call.callId, 7201);
    expect(await a.next("ended")).toMatchObject({ reason: "max_duration" });
    expect(await b.next("ended")).toMatchObject({ reason: "max_duration" });
  });

  it("a participant whose connection drops for 30 s is taken out of the call", async () => {
    const dad = await phone(issuer, uniqueAccount());
    const mum = await phone(issuer, uniqueAccount());
    const { call } = await dad.create();
    await mum.join(call.callId);
    const a = await dad.events(call.callId);
    const b = await mum.events(call.callId);
    await a.next("roster");
    b.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await advance(call.callId, 31);
    expect(await a.next("left")).toMatchObject({ accountId: mum.accountId, reason: "disconnected" });
    a.close();
  });
});

describe("GET /v1/calls (call log)", () => {
  it("lists the conversation's calls, newest first, metadata only", async () => {
    const dad = await phone(issuer, uniqueAccount(), 1, ["conv-log"]);
    const first = await dad.create("conv-log");
    await dad.request("POST", `/v1/calls/${first.call.callId}/leave`);
    const second = await dad.create("conv-log");
    const res = await dad.request("GET", "/v1/calls?conversationId=conv-log");
    expect(res.status).toBe(200);
    const { calls } = await res.json<{ calls: { callId: string; endReason: string | null }[] }>();
    expect(calls.map((c) => c.callId)).toEqual([second.call.callId, first.call.callId]);
    expect(calls[1]).toMatchObject({ endReason: "hung_up" });
    expect(Object.keys(calls[0] ?? {}).sort()).toEqual(
      ["answeredAt", "callId", "createdAt", "createdBy", "endReason", "endedAt", "peakParticipants"].sort(),
    );
  });

  it("only for a conversation in the token", async () => {
    const dad = await phone(issuer, uniqueAccount(), 1, ["conv-1"]);
    expect((await dad.request("GET", "/v1/calls?conversationId=conv-2")).status).toBe(403);
    expect((await dad.request("GET", "/v1/calls")).status).toBe(400);
  });

  it("the daily purge drops calls older than the retention period", async () => {
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO calls (id, conversation_id, created_by_account, created_by_device, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("old-call", "conv-1", "a", 1, old)
      .run();
    const dad = await phone(issuer, uniqueAccount());
    const { call } = await dad.create();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron: "23 3 * * *" }), env);
    expect(await row("old-call")).toBeNull();
    expect(await row(call.callId)).not.toBeNull();
  });
});
