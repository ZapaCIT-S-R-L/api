// Membership for the chat and calls services: which scopes an account belongs to, who is in a scope, and the
// membership events (transactional outbox in D1, sent to the MEMBERSHIP_EVENTS queue, at least once, in order).
import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { conversationScopes, familyScope, membersOf } from "../../src/family-membership";
import { flushMembershipEvents, type MembershipEvent } from "../../src/membership-events";
import { call, makeIssuer, resetJwksCache, signInParent, stubJwks, type TestIssuer } from "./helpers";

let apple: TestIssuer;

beforeEach(async () => {
  resetJwksCache();
  apple = await makeIssuer();
  stubJwks([apple], []);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const send = (path: string, auth: Record<string, string>, body: unknown = {}) =>
  call(path, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

async function familyOf(auth: Record<string, string>): Promise<string> {
  return (await (await send("/v1/families", auth)).json<{ id: string }>()).id;
}

async function addKid(auth: Record<string, string>, familyId: string, nickname = "Mia"): Promise<string> {
  const res = await send(`/v1/families/${familyId}/kids`, auth, { nickname, avatar: "robot-1" });
  return (await res.json<{ id: string }>()).id;
}

async function joinWithInvite(owner: Record<string, string>, familyId: string, joiner: Record<string, string>) {
  const { code } = await (await send(`/v1/families/${familyId}/parents/invitations`, owner)).json<{ code: string }>();
  return send("/v1/families/join", joiner, { code });
}

async function outbox(): Promise<(MembershipEvent & { sent: boolean })[]> {
  const { results } = await env.DB.prepare("SELECT seq, body, sent_at FROM membership_outbox ORDER BY seq").all<{
    seq: number;
    body: string;
    sent_at: string | null;
  }>();
  return results.map((r) => ({ ...(JSON.parse(r.body) as MembershipEvent), seq: r.seq, sent: r.sent_at !== null }));
}

class FakeQueue {
  sent: unknown[] = [];
  fail = false;
  sendBatch(messages: Iterable<MessageSendRequest>): Promise<void> {
    if (this.fail) return Promise.reject(new Error("queue down"));
    for (const m of messages) this.sent.push(m.body);
    return Promise.resolve();
  }
}

function withQueue(queue: FakeQueue | undefined) {
  return { ...env, MEMBERSHIP_EVENTS: queue as unknown as Queue };
}

describe("scopes and members", () => {
  it("a parent and a kid are in their family's scope", async () => {
    const ana = await signInParent(apple, "ana");
    const familyId = await familyOf(ana.auth);
    const kidId = await addKid(ana.auth, familyId);
    expect(familyScope(familyId)).toBe(`family:${familyId}`);
    expect(await conversationScopes(env, ana.id)).toEqual([`family:${familyId}`]);
    expect(await conversationScopes(env, kidId)).toEqual([`family:${familyId}`]);
    expect(await conversationScopes(env, crypto.randomUUID())).toEqual([]);
  });

  it("membersOf lists the parents and kids of a family scope", async () => {
    const ana = await signInParent(apple, "ana");
    const dan = await signInParent(apple, "dan");
    const familyId = await familyOf(ana.auth);
    await joinWithInvite(ana.auth, familyId, dan.auth);
    const kidId = await addKid(ana.auth, familyId);
    const members = await membersOf(env, `family:${familyId}`);
    expect(members).toEqual(
      expect.arrayContaining([
        { accountId: ana.id, role: "parent" },
        { accountId: dan.id, role: "parent" },
        { accountId: kidId, role: "kid" },
      ]),
    );
    expect(members).toHaveLength(3);
  });

  it("an unknown or malformed scope has no members", async () => {
    expect(await membersOf(env, `family:${crypto.randomUUID()}`)).toEqual([]);
    expect(await membersOf(env, "nonsense")).toEqual([]);
    expect(await membersOf(env, "connection:x")).toEqual([]);
  });
});

describe("membership events (outbox)", () => {
  it("creating a family adds its first parent", async () => {
    const ana = await signInParent(apple, "ana");
    const familyId = await familyOf(ana.auth);
    await familyOf(ana.auth); // idempotent: no second event
    const events = await outbox();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      version: 1,
      type: "member.added",
      scope: `family:${familyId}`,
      familyId,
      account: { id: ana.id, role: "parent" },
    });
    expect(events[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(events[0]?.occurredAt ?? "")).not.toBeNaN();
  });

  it("joining adds the second parent; leaving an empty family deletes its scope first", async () => {
    const ana = await signInParent(apple, "ana");
    const dan = await signInParent(apple, "dan");
    const familyId = await familyOf(ana.auth);
    const dansOld = await familyOf(dan.auth);
    expect((await joinWithInvite(ana.auth, familyId, dan.auth)).status).toBe(200);
    const events = (await outbox()).slice(2);
    expect(events.map((e) => [e.type, e.scope, e.account?.id])).toEqual([
      ["scope.deleted", `family:${dansOld}`, undefined],
      ["member.added", `family:${familyId}`, dan.id],
    ]);
  });

  it("adding a kid adds the kid", async () => {
    const ana = await signInParent(apple, "ana");
    const familyId = await familyOf(ana.auth);
    const kidId = await addKid(ana.auth, familyId);
    const last = (await outbox()).at(-1);
    expect(last).toMatchObject({
      type: "member.added",
      scope: `family:${familyId}`,
      account: { id: kidId, role: "kid" },
    });
  });

  it("refused changes emit nothing", async () => {
    const ana = await signInParent(apple, "ana");
    const eve = await signInParent(apple, "eve");
    const familyId = await familyOf(ana.auth);
    for (let i = 0; i < 12; i++) await addKid(ana.auth, familyId, `K${i}`);
    const before = (await outbox()).length;
    expect((await send(`/v1/families/${familyId}/kids`, ana.auth, { nickname: "X", avatar: "a" })).status).toBe(409);
    expect((await send("/v1/families/join", eve.auth, { code: `zki_${"A".repeat(43)}` })).status).toBe(410);
    expect((await outbox()).length).toBe(before);
  });

  it("flush sends unsent events in order, once, with seq; then marks them sent", async () => {
    const ana = await signInParent(apple, "ana");
    const familyId = await familyOf(ana.auth);
    await addKid(ana.auth, familyId);
    await env.DB.prepare("UPDATE membership_outbox SET sent_at = NULL").run();
    const queue = new FakeQueue();
    expect(await flushMembershipEvents(withQueue(queue))).toBe(2);
    const sent = queue.sent as MembershipEvent[];
    expect(sent.map((e) => e.type)).toEqual(["member.added", "member.added"]);
    expect(sent.map((e) => e.account?.role)).toEqual(["parent", "kid"]);
    expect((sent[0]?.seq ?? 0) < (sent[1]?.seq ?? 0)).toBe(true);
    expect((await outbox()).every((e) => e.sent)).toBe(true);
    expect(await flushMembershipEvents(withQueue(queue))).toBe(0);
    expect(queue.sent).toHaveLength(2);
  });

  it("a failing queue or no queue binding keeps the events for the next flush", async () => {
    const ana = await signInParent(apple, "ana");
    await familyOf(ana.auth);
    await env.DB.prepare("UPDATE membership_outbox SET sent_at = NULL").run();
    const queue = new FakeQueue();
    queue.fail = true;
    expect(await flushMembershipEvents(withQueue(queue))).toBe(0);
    expect(await flushMembershipEvents(withQueue(undefined))).toBe(0);
    expect((await outbox()).some((e) => e.sent)).toBe(false);
    queue.fail = false;
    expect(await flushMembershipEvents(withQueue(queue))).toBe(1);
  });

  it("a failing queue doesn't fail the request", async () => {
    const ana = await signInParent(apple, "ana");
    const queue = new FakeQueue();
    queue.fail = true;
    const request = new Request("https://api.test/v1/families", {
      method: "POST",
      headers: { ...ana.auth, "cf-connecting-ip": "10.1.2.3" },
    }) as Parameters<typeof worker.fetch>[0];
    expect((await worker.fetch(request, withQueue(queue))).status).toBe(201);
    expect((await outbox()).map((e) => e.sent)).toEqual([false]);
  });

  it("the cron sends what is left, and purges sent events after 7 days", async () => {
    const ana = await signInParent(apple, "ana");
    await familyOf(ana.auth);
    await env.DB.prepare("UPDATE membership_outbox SET sent_at = NULL").run();
    const queue = new FakeQueue();
    await worker.scheduled(createScheduledController({ cron: "17 3 * * *" }), withQueue(queue));
    expect(queue.sent).toHaveLength(1);
    await env.DB.prepare("UPDATE membership_outbox SET sent_at = ?")
      .bind(new Date(Date.now() - 8 * 86_400_000).toISOString())
      .run();
    await worker.scheduled(createScheduledController({ cron: "17 3 * * *" }), withQueue(queue));
    expect(await outbox()).toEqual([]);
  });
});
