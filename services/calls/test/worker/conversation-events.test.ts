// Conversation events from the chat service (src/conversation-events.ts, the queue consumer): a member chat removes
// from a conversation is out of its live call at once, with the call key rotated without them and their SFU tracks
// closed (retried until Realtime confirms); a closed conversation ends the call. A replayed or late event never
// drops a member who was readmitted meanwhile.
import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEvent } from "../../src/conversation-events";
import worker from "../../src/index";
import { resetJwksCache } from "../../src/jwks";
import { addMember, errorCode, phone, removeMember, type Phone, type Socket } from "./calls-helpers";
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
let events = 0;

beforeEach(async () => {
  resetJwksCache();
  issuer = await makeIssuer();
  realtime = fakeRealtime(stubFetch([issuer]));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const room = (callId: string) => env.CALL.get(env.CALL.idFromName(callId));

// Moves the clock forward and runs the call's alarm, as if that much time passed.
async function advance(callId: string, seconds: number) {
  vi.useFakeTimers({ now: Date.now() + seconds * 1000, toFake: ["Date"] });
  await runDurableObjectAlarm(room(callId));
}

const closeRequests = () => realtime.requests.filter((r) => r.method === "PUT" && r.path.endsWith("/tracks/close"));
const applied = () =>
  env.DB.prepare("SELECT id FROM processed_events ORDER BY id")
    .all()
    .then((r) => r.results);

function event(body: Record<string, unknown>): Record<string, unknown> {
  events++;
  const id = `00000000-0000-4000-8000-${events.toString(16).padStart(12, "0")}`;
  return { v: 1, id, occurredAt: new Date().toISOString(), ...body };
}

async function deliver(bodies: unknown[]) {
  const batch = createMessageBatch(
    "zapakid-conversation-events-local",
    bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body })),
  );
  const ctx = createExecutionContext();
  await worker.queue(batch, env);
  return getQueueResult(batch, ctx);
}

const sdp = { type: "offer", sdp: "v=0 fake offer" };
const blob = (n: number) => btoa(String.fromCharCode(...new Uint8Array(n).fill(7)));

async function session(p: Phone, callId: string): Promise<string> {
  const res = await p.request("POST", `/v1/calls/${callId}/sessions`, { sessionDescription: sdp });
  expect(res.status).toBe(201);
  return (await res.json<{ sessionId: string }>()).sessionId;
}

async function publish(p: Phone, callId: string, sessionId: string, trackName: string): Promise<void> {
  const res = await p.request("POST", `/v1/calls/${callId}/sessions/${sessionId}/tracks/new`, {
    sessionDescription: sdp,
    tracks: [{ location: "local", trackName }],
  });
  expect(res.status).toBe(200);
}

async function subscribe(p: Phone, callId: string, sessionId: string, from: string, trackName: string) {
  const res = await p.request("POST", `/v1/calls/${callId}/sessions/${sessionId}/tracks/new`, {
    tracks: [{ location: "remote", sessionId: from, trackName }],
  });
  expect(res.status).toBe(200);
}

// Dad starts a call in conv-1; mum joins with two devices (4 and 5), grandma with one. Everyone's events socket is
// open; dad and mum's device 4 have SFU sessions, each publishing a track and pulling the other's.
async function familyCall(conversationId = "conv-1") {
  const dad = await phone(issuer, uniqueAccount(), 1, [conversationId]);
  const mumId = uniqueAccount();
  const mum4 = await phone(issuer, mumId, 4, [conversationId]);
  const mum5 = await phone(issuer, mumId, 5, [conversationId]);
  const grandma = await phone(issuer, uniqueAccount(), 1, [conversationId]);
  const { call } = await dad.create(conversationId);
  const callId = call.callId;
  for (const p of [mum4, mum5, grandma]) expect((await p.join(callId)).status).toBe(200);
  const sockets = {
    dad: await dad.events(callId),
    mum4: await mum4.events(callId),
    mum5: await mum5.events(callId),
    grandma: await grandma.events(callId),
  };
  for (const s of Object.values(sockets)) await s.next("roster");
  const dadSession = await session(dad, callId);
  const mumSession = await session(mum4, callId);
  await publish(dad, callId, dadSession, "audio-dad");
  await publish(mum4, callId, mumSession, "audio-mum");
  await subscribe(dad, callId, dadSession, mumSession, "audio-mum");
  await subscribe(mum4, callId, mumSession, dadSession, "audio-dad");
  return { dad, mum4, mum5, grandma, callId, sockets, dadSession, mumSession };
}

const closed = (s: Socket) => s.messages.some((m) => m.type === "__closed");

describe("conversation.members_removed", () => {
  it("drops every device of the member: left/removed with a new epoch, sockets closed, SFU tracks closed, no new key", async () => {
    const { dad, mum4, mum5, grandma, callId, sockets, mumSession, dadSession } = await familyCall();
    // The chat service removed mum (unpaired, left the family...): it no longer lists her, and tells us.
    await removeMember("conv-1", mum4.accountId);
    const result = await deliver([
      event({ type: "conversation.members_removed", conversationId: "conv-1", accountIds: [mum4.accountId] }),
    ]);
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(result.retryMessages).toEqual([]);

    // Epochs: 1 start, 2-4 the three joins, 5 the removal (one bump for both of mum's devices).
    const left1 = await sockets.dad.next("left");
    const left2 = await sockets.dad.next("left");
    expect([left1, left2].map((m) => m.deviceId).sort()).toEqual([4, 5]);
    for (const m of [left1, left2]) expect(m).toMatchObject({ accountId: mum4.accountId, epoch: 5, reason: "removed" });
    const roster = (await sockets.dad.next("roster")).call as CallView;
    expect(roster.epoch).toBe(5);
    expect(roster.participants.map((p) => p.accountId)).toEqual([dad.accountId, grandma.accountId]);
    expect(roster.keyLeader).toEqual({ accountId: dad.accountId, deviceId: 1 });
    await sockets.mum4.next("__closed");
    await sockets.mum5.next("__closed");
    expect(closed(sockets.dad)).toBe(false);
    expect(closed(sockets.grandma)).toBe(false);

    // Mum's SFU session: every track closed (her published audio and the one she pulled from dad), by force.
    const closeCalls = realtime.requests.filter((r) => r.method === "PUT" && r.path.endsWith("/tracks/close"));
    expect(closeCalls).toEqual([
      expect.objectContaining({
        path: `/apps/test-app-id/sessions/${mumSession}/tracks/close`,
        auth: "Bearer test-app-secret",
        body: { tracks: [{ mid: "0" }, { mid: "1" }], force: true },
      }),
    ]);
    expect(realtime.tracks.get(mumSession)).toEqual([]);
    expect(realtime.tracks.get(dadSession)).toHaveLength(2);

    // The key leader rotates the call key for epoch 5: to grandma only. Sealing one for mum is refused.
    sockets.dad.send({
      type: "keys",
      epoch: 5,
      envelopes: [{ toAccount: grandma.accountId, toDevice: 1, blob: blob(32) }],
    });
    expect(await sockets.dad.next("keys_ack")).toMatchObject({ epoch: 5, delivered: 1, queued: 0 });
    expect(await sockets.grandma.next("key")).toMatchObject({ epoch: 5, fromAccount: dad.accountId });
    sockets.dad.send({
      type: "keys",
      epoch: 5,
      envelopes: [{ toAccount: mum4.accountId, toDevice: 5, blob: blob(32) }],
    });
    expect(await sockets.dad.next("keys_ack").catch(() => null)).toBeNull();
    expect(sockets.dad.messages.filter((m) => m.type === "error")).toEqual([
      expect.objectContaining({ code: "not_participant" }),
    ]);
    expect(sockets.mum4.messages.filter((m) => m.type === "key")).toEqual([]);
    expect(sockets.mum5.messages.filter((m) => m.type === "key")).toEqual([]);

    // From now on the call doesn't exist for her: no view, no rejoin, no new events socket, no new SFU session.
    expect((await mum4.request("GET", `/v1/calls/${callId}`)).status).toBe(404);
    expect((await mum5.join(callId)).status).toBe(404);
    await expect(mum4.events(callId)).rejects.toThrow(/404/);
    const newSession = await mum4.request("POST", `/v1/calls/${callId}/sessions`, { sessionDescription: sdp });
    expect(newSession.status).toBe(404);
    // The call goes on for the others, with the log untouched.
    expect((await grandma.request("GET", `/v1/calls/${callId}`)).status).toBe(200);
    const row = await env.DB.prepare("SELECT ended_at, peak_participants FROM calls WHERE id = ?1")
      .bind(callId)
      .first();
    expect(row).toEqual({ ended_at: null, peak_participants: 4 });
    for (const s of Object.values(sockets)) s.close();
  });

  it("removing the last participants ends the call (hung_up); a member who only rang is not rung on", async () => {
    const dad = await phone(issuer, uniqueAccount(), 1);
    const mum = await phone(issuer, uniqueAccount(), 2);
    const { call } = await dad.create();
    const a = await dad.events(call.callId);
    const b = await mum.events(call.callId);
    for (const s of [a, b]) await s.next("roster");
    await removeMember("conv-1", dad.accountId);
    await deliver([
      event({ type: "conversation.members_removed", conversationId: "conv-1", accountIds: [dad.accountId] }),
    ]);
    expect(await b.next("left")).toMatchObject({ accountId: dad.accountId, deviceId: 1, epoch: 2, reason: "removed" });
    expect(await b.next("ended")).toEqual({ type: "ended", reason: "hung_up" });
    await a.next("__closed");
    await b.next("__closed");
    const row = await env.DB.prepare("SELECT end_reason FROM calls WHERE id = ?1").bind(call.callId).first();
    expect(row).toEqual({ end_reason: "hung_up" });
    expect((await mum.request("GET", `/v1/calls/${call.callId}`)).status).toBe(200);
    expect(await errorCode(await mum.join(call.callId))).toBe("call_ended");
  });

  it("is a no-op for accounts not in the call, for ended calls and for conversations without a call", async () => {
    const dad = await phone(issuer, uniqueAccount(), 1);
    const mum = await phone(issuer, uniqueAccount(), 2);
    const { call } = await dad.create();
    await mum.join(call.callId);
    const a = await dad.events(call.callId);
    await a.next("roster");
    const result = await deliver([
      event({ type: "conversation.members_removed", conversationId: "conv-1", accountIds: ["nobody", "else"] }),
      event({
        type: "conversation.members_removed",
        conversationId: "conv-without-calls",
        accountIds: [dad.accountId],
      }),
      event({ type: "conversation.closed", conversationId: "conv-without-calls" }),
    ]);
    expect(result.explicitAcks.sort()).toEqual(["m0", "m1", "m2"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(a.messages.filter((m) => m.type !== "roster")).toEqual([]);
    const view = await (await dad.request("GET", `/v1/calls/${call.callId}`)).json<CallView>();
    expect(view.epoch).toBe(2);
    expect(view.participants).toHaveLength(2);

    await dad.request("POST", `/v1/calls/${call.callId}/leave`);
    await mum.request("POST", `/v1/calls/${call.callId}/leave`);
    const after = await deliver([
      event({ type: "conversation.members_removed", conversationId: "conv-1", accountIds: [mum.accountId] }),
    ]);
    expect(after.explicitAcks).toEqual(["m0"]);
    expect(realtime.requests.filter((r) => r.path.includes("/sessions/"))).toEqual([]);
    a.close();
  });

  it("still drops the member when Realtime is down, acks, and keeps the SFU clean-up to retry until the tracks close", async () => {
    const { mum4, sockets, callId, dad, mumSession } = await familyCall();
    await removeMember("conv-1", mum4.accountId);
    realtime.failNext = 503;
    const result = await deliver([
      event({ type: "conversation.members_removed", conversationId: "conv-1", accountIds: [mum4.accountId] }),
    ]);
    expect(result.explicitAcks).toEqual(["m0"]);
    await sockets.mum4.next("__closed");
    expect(await sockets.dad.next("left")).toMatchObject({ accountId: mum4.accountId, reason: "removed" });
    const view = await (await dad.request("GET", `/v1/calls/${callId}`)).json<CallView>();
    expect(view.participants.map((p) => p.accountId)).not.toContain(mum4.accountId);

    // Her tracks are still open on the SFU; the room remembers the session and has a retry due in 5 s.
    expect(closeRequests()).toEqual([]);
    expect(realtime.tracks.get(mumSession)).toHaveLength(2);
    const pending = await room(callId).pendingCloses();
    expect(pending).toEqual([{ sessionId: mumSession, attempts: 1, nextAt: expect.any(Number) as number }]);
    expect(pending[0]?.nextAt).toBeGreaterThan(Date.now() + 4000);
    const alarm = await runInDurableObject(room(callId), (_, state) => state.storage.getAlarm());
    expect(alarm).toBe(pending[0]?.nextAt);

    // Realtime is still down at the first retry: the backoff doubles (10 s).
    realtime.failNext = 503;
    await advance(callId, 6);
    expect(realtime.tracks.get(mumSession)).toHaveLength(2);
    const second = await room(callId).pendingCloses();
    expect(second).toEqual([{ sessionId: mumSession, attempts: 2, nextAt: expect.any(Number) as number }]);
    expect(second[0]?.nextAt).toBeGreaterThan(Date.now() + 9000);
    // Not due yet: the alarm runs but leaves it alone.
    await advance(callId, 2);
    expect(await room(callId).pendingCloses()).toEqual(second);

    // Realtime is back at the second retry: every track closed by force, nothing left to retry.
    await advance(callId, 10);
    expect(closeRequests()).toEqual([
      expect.objectContaining({
        path: `/apps/test-app-id/sessions/${mumSession}/tracks/close`,
        body: { tracks: [{ mid: "0" }, { mid: "1" }], force: true },
      }),
    ]);
    expect(realtime.tracks.get(mumSession)).toEqual([]);
    expect(await room(callId).pendingCloses()).toEqual([]);
    // The call is still on for the others, with its usual timers.
    const after = await (await dad.request("GET", `/v1/calls/${callId}`)).json<CallView>();
    expect(after.state).toBe("active");
    expect(after.participants).toHaveLength(2);
    for (const s of Object.values(sockets)) s.close();
  });

  it.each([
    ["GET session", "failNext"],
    ["PUT tracks/close", "failNextClose"],
  ] as const)("keeps the SFU clean-up to retry when Realtime rate limits the %s (429)", async (_, fail) => {
    const { mum4, sockets, callId, mumSession } = await familyCall();
    await removeMember("conv-1", mum4.accountId);
    realtime[fail] = 429;
    const result = await deliver([
      event({ type: "conversation.members_removed", conversationId: "conv-1", accountIds: [mum4.accountId] }),
    ]);
    expect(result.explicitAcks).toEqual(["m0"]);
    await sockets.mum4.next("__closed");

    // A rate limit is not a refusal: her tracks are still open and the session stays on the list, retry due in 5 s.
    expect(realtime.tracks.get(mumSession)).toHaveLength(2);
    const pending = await room(callId).pendingCloses();
    expect(pending).toEqual([{ sessionId: mumSession, attempts: 1, nextAt: expect.any(Number) as number }]);
    expect(pending[0]?.nextAt).toBeGreaterThan(Date.now() + 4000);

    // The retry gets through: every track closed, nothing left to retry.
    await advance(callId, 6);
    expect(realtime.tracks.get(mumSession)).toEqual([]);
    expect(await room(callId).pendingCloses()).toEqual([]);
    for (const s of Object.values(sockets)) s.close();
  });

  it("retries the SFU clean-up after the call has ended too, and stops when Realtime says the session is gone", async () => {
    const dad = await phone(issuer, uniqueAccount(), 1);
    const mum = await phone(issuer, uniqueAccount(), 2);
    const { call } = await dad.create();
    await mum.join(call.callId);
    const dadSession = await session(dad, call.callId);
    const mumSession = await session(mum, call.callId);
    await publish(dad, call.callId, dadSession, "audio-dad");
    await publish(mum, call.callId, mumSession, "audio-mum");
    const closedAt = new Date().toISOString();
    realtime.failNext = 503;
    const result = await deliver([
      event({ type: "conversation.closed", conversationId: "conv-1", occurredAt: closedAt }),
    ]);
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(await errorCode(await mum.join(call.callId))).toBe("call_ended");
    // Dad's session failed (Realtime down), mum's was closed: the outage was over by then.
    expect(await room(call.callId).pendingCloses()).toEqual([
      { sessionId: dadSession, attempts: 1, nextAt: expect.any(Number) as number },
    ]);
    expect(realtime.tracks.get(mumSession)).toEqual([]);
    expect(realtime.tracks.get(dadSession)).toHaveLength(1);

    // Dad's phone dropped its session meanwhile: Realtime answers 404, and that is the end of it.
    realtime.sessions.splice(realtime.sessions.indexOf(dadSession), 1);
    await advance(call.callId, 6);
    expect(await room(call.callId).pendingCloses()).toEqual([]);
    expect(closeRequests().map((r) => r.path)).toEqual([`/apps/test-app-id/sessions/${mumSession}/tracks/close`]);
    // The ended call is still kept for its hour (410 for late requests).
    expect(await errorCode(await mum.join(call.callId))).toBe("call_ended");
  });

  it("a replayed event does not drop a member who was readmitted and rejoined since", async () => {
    const { dad, mum4, mum5, grandma, callId, sockets } = await familyCall();
    await removeMember("conv-1", mum4.accountId);
    const removal = event({
      type: "conversation.members_removed",
      conversationId: "conv-1",
      accountIds: [mum4.accountId],
    });
    expect((await deliver([removal])).explicitAcks).toEqual(["m0"]);
    await sockets.mum4.next("__closed");
    await sockets.mum5.next("__closed");
    expect(await applied()).toEqual([{ id: removal.id }]);

    // Chat readmits mum (paired again); she rejoins on device 4 and connects.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await addMember("conv-1", mum4.accountId, 4);
    expect((await mum4.join(callId)).status).toBe(200);
    const mumSocket = await mum4.events(callId);
    await mumSocket.next("roster");
    const before = await (await dad.request("GET", `/v1/calls/${callId}`)).json<CallView>();
    expect(before.participants.map((p) => p.accountId)).toEqual([dad.accountId, grandma.accountId, mum4.accountId]);

    // The queue delivers the removal again (at least once): acknowledged, not applied.
    const replay = await deliver([removal]);
    expect(replay.explicitAcks).toEqual(["m0"]);
    expect(replay.retryMessages).toEqual([]);
    // A late copy with another id, from before she rejoined (the outbox flushed by the cron, say): not applied either.
    const late = await deliver([{ ...removal, id: "00000000-0000-4000-8000-00000000fffe" }]);
    expect(late.explicitAcks).toEqual(["m0"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed(mumSocket)).toBe(false);
    const view = await (await dad.request("GET", `/v1/calls/${callId}`)).json<CallView>();
    expect(view.epoch).toBe(before.epoch);
    expect(view.participants.map((p) => p.accountId)).toEqual([dad.accountId, grandma.accountId, mum4.accountId]);
    expect(await applied()).toEqual([{ id: removal.id }, { id: "00000000-0000-4000-8000-00000000fffe" }]);

    // A new removal, from after her rejoin, drops her again.
    await removeMember("conv-1", mum4.accountId);
    await deliver([
      event({ type: "conversation.members_removed", conversationId: "conv-1", accountIds: [mum4.accountId] }),
    ]);
    await mumSocket.next("__closed");
    const after = await (await dad.request("GET", `/v1/calls/${callId}`)).json<CallView>();
    expect(after.epoch).toBe(before.epoch + 1);
    expect(after.participants.map((p) => p.accountId)).toEqual([dad.accountId, grandma.accountId]);
    expect(mum5.accountId).toBe(mum4.accountId);
    for (const s of Object.values(sockets)) s.close();
  });
});

describe("conversation.closed", () => {
  it("is ignored when older than the call (the conversation was reopened and a new call started since)", async () => {
    const closedAt = new Date(Date.now() - 1000).toISOString();
    const dad = await phone(issuer, uniqueAccount(), 1);
    const mum = await phone(issuer, uniqueAccount(), 2);
    const { call } = await dad.create();
    await mum.join(call.callId);
    const a = await dad.events(call.callId);
    await a.next("roster");
    const result = await deliver([
      event({ type: "conversation.closed", conversationId: "conv-1", occurredAt: closedAt }),
      event({
        type: "conversation.members_removed",
        conversationId: "conv-1",
        accountIds: [mum.accountId],
        occurredAt: closedAt,
      }),
    ]);
    expect(result.explicitAcks.sort()).toEqual(["m0", "m1"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(a.messages.filter((m) => m.type !== "roster")).toEqual([]);
    const view = await (await dad.request("GET", `/v1/calls/${call.callId}`)).json<CallView>();
    expect(view.state).toBe("active");
    expect(view.participants).toHaveLength(2);
    a.close();
  });

  it("ends the call for everyone and closes their SFU tracks", async () => {
    const { sockets, callId, dadSession, mumSession } = await familyCall();
    const result = await deliver([event({ type: "conversation.closed", conversationId: "conv-1" })]);
    expect(result.explicitAcks).toEqual(["m0"]);
    for (const s of Object.values(sockets)) {
      expect(await s.next("ended")).toEqual({ type: "ended", reason: "hung_up" });
      await s.next("__closed");
    }
    expect(sockets.grandma.messages.filter((m) => m.type === "left")).toHaveLength(4);
    const closedSessions = realtime.requests.filter((r) => r.path.endsWith("/tracks/close")).map((r) => r.path);
    expect(closedSessions.sort()).toEqual(
      [dadSession, mumSession].map((s) => `/apps/test-app-id/sessions/${s}/tracks/close`).sort(),
    );
    const row = await env.DB.prepare("SELECT end_reason FROM calls WHERE id = ?1").bind(callId).first();
    expect(row).toEqual({ end_reason: "hung_up" });
  });
});

describe("the queue consumer", () => {
  it("acks unknown types, retries malformed events", async () => {
    const result = await deliver([
      event({ type: "conversation.renamed", conversationId: "conv-1" }),
      { v: 1, id: "not-a-uuid", type: "conversation.closed", conversationId: "conv-1" },
      event({ type: "conversation.members_removed", conversationId: "conv-1", accountIds: [] }),
      event({ type: "conversation.members_removed", conversationId: "conv-1", accountIds: ["bad id"] }),
      event({ type: "conversation.closed", conversationId: "../etc" }),
      "a string",
    ]);
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(result.retryMessages.map((m) => m.msgId).sort()).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  it("parseEvent: accounts deduplicated, at most 64; occurredAt a date; unknown types null", () => {
    const parsed = parseEvent(
      event({ type: "conversation.members_removed", conversationId: "c", accountIds: ["a", "a", "b"] }),
    );
    expect(parsed).toMatchObject({ type: "conversation.members_removed", conversationId: "c", accountIds: ["a", "b"] });
    expect(parseEvent(event({ type: "something.else" }))).toBeNull();
    const many = Array.from({ length: 65 }, (_, i) => `a${i}`);
    expect(() =>
      parseEvent(event({ type: "conversation.members_removed", conversationId: "c", accountIds: many })),
    ).toThrow();
    expect(() =>
      parseEvent(event({ type: "conversation.closed", conversationId: "c", occurredAt: "yesterday" })),
    ).toThrow(/occurredAt/);
  });

  it("remembers applied event ids for 14 days; the daily purge drops older ones", async () => {
    const old = new Date(Date.now() - 15 * 86_400_000).toISOString();
    await env.DB.prepare("INSERT INTO processed_events (id, processed_at) VALUES (?1, ?2)")
      .bind("00000000-0000-4000-8000-00000000000a", old)
      .run();
    const fresh = event({ type: "conversation.closed", conversationId: "conv-without-calls" });
    await deliver([fresh]);
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron: "23 3 * * *" }), env);
    expect(await applied()).toEqual([{ id: fresh.id }]);
  });
});
