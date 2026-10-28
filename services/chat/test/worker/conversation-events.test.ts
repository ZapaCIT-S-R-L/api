// Conversation events for the calls service (src/conversation-events.ts): written in the outbox with the change,
// sent to the CONVERSATION_EVENTS queue right after, kept for the next flush when the queue fails.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  flushConversationEvents,
  purgeConversationOutbox,
  type ConversationEvent,
} from "../../src/conversation-events";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import {
  ALEX,
  ANA,
  apply,
  as,
  DAD,
  makeIssuer,
  MARIA,
  MUM,
  recordingRooms,
  seedFamilies,
  stubJwks,
  tokenFor,
  type ConversationBody,
  type Issuer,
} from "./helpers";

let issuer: Issuer;

beforeEach(async () => {
  issuer = await makeIssuer();
  stubJwks(issuer);
});

async function create(account: string, members: string[]): Promise<ConversationBody> {
  const res = await as(await tokenFor(issuer, account), "/v1/conversations", {
    method: "POST",
    body: JSON.stringify({ members }),
  });
  expect(res.status).toBe(201);
  return res.json<ConversationBody>();
}

interface Row {
  seq: number;
  body: string;
  sent_at: number | null;
}

async function outbox(): Promise<(ConversationEvent & { sent: boolean })[]> {
  const { results } = await env.DB.prepare(
    "SELECT seq, body, sent_at FROM conversation_outbox ORDER BY seq",
  ).all<Row>();
  return results.map((r) => ({ ...(JSON.parse(r.body) as ConversationEvent), sent: r.sent_at !== null }));
}

// A queue that records what it gets, or fails.
function fakeQueue(fail = false): Queue & { sent: ConversationEvent[] } {
  const sent: ConversationEvent[] = [];
  const queue = {
    sent,
    send: (): Promise<void> => Promise.reject(new Error("use sendBatch")),
    sendBatch: (messages: Iterable<MessageSendRequest<ConversationEvent>>): Promise<void> => {
      if (fail) return Promise.reject(new Error("queue down (test)"));
      for (const m of messages) sent.push(m.body);
      return Promise.resolve();
    },
  };
  return queue as unknown as Queue & { sent: ConversationEvent[] };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("conversation events for the calls service", () => {
  it("a parent leaving the family: members_removed for each conversation, written with the change and sent", async () => {
    await seedFamilies();
    const c = await create(MUM, [ALEX]);
    await apply(recordingRooms(), { type: "family.member_removed", familyId: "fam1", accountId: DAD });
    const events = await outbox();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      v: 1,
      type: "conversation.members_removed",
      conversationId: c.id,
      accountIds: [DAD],
      sent: true,
    });
    expect(events[0]?.id).toMatch(UUID);
    expect(Date.parse(events[0]?.occurredAt ?? "")).toBeGreaterThan(0);
  });

  it("removing the connection: conversation.closed for the cross-family chat only", async () => {
    await seedFamilies();
    const cross = await create(MUM, [ALEX, MARIA]);
    await create(MUM, [ALEX]);
    await apply(recordingRooms(), { type: "connection.removed", connectionId: "con12" });
    const events = await outbox();
    expect(events.map((e) => [e.type, e.conversationId])).toEqual([["conversation.closed", cross.id]]);
  });

  it("account deletion: members_removed, then closed when one member is left", async () => {
    await seedFamilies();
    const direct = await create(MUM, [ANA]);
    await apply(recordingRooms(), { type: "account.deleted", accountId: ANA });
    const events = await outbox();
    expect(events.map((e) => e.type)).toEqual(["conversation.members_removed", "conversation.closed"]);
    expect(events[0]).toMatchObject({ conversationId: direct.id, accountIds: [ANA] });
    expect(events[1]).toMatchObject({ conversationId: direct.id });
  });

  it("a member deleting the conversation is removed from its calls too", async () => {
    await seedFamilies();
    const c = await create(MUM, [ANA]);
    const res = await as(await tokenFor(issuer, ANA), `/v1/conversations/${c.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await outbox()).toEqual([
      expect.objectContaining({ type: "conversation.members_removed", conversationId: c.id, accountIds: [ANA] }),
    ]);
  });

  it("nothing is sent when nobody is removed (a parent joining)", async () => {
    await seedFamilies();
    await create(MUM, [ALEX]);
    await apply(recordingRooms(), {
      type: "family.member_added",
      familyId: "fam1",
      accountId: "acc_step",
      role: "parent",
    });
    expect(await outbox()).toEqual([]);
  });

  it("a failing queue keeps the events for the next flush, in order; a missing binding too", async () => {
    await seedFamilies();
    const c = await create(MUM, [ALEX]);
    const down: Env = { ...env, CONVERSATION_EVENTS: fakeQueue(true) };
    await apply(recordingRooms(), { type: "family.member_removed", familyId: "fam1", accountId: DAD });
    // Simulate the flush having failed: mark the row unsent again and flush against the failing queue.
    await env.DB.prepare("UPDATE conversation_outbox SET sent_at = NULL").run();
    expect(await flushConversationEvents(down)).toBe(0);
    expect((await outbox()).map((e) => e.sent)).toEqual([false]);
    const none: Env = { ...env };
    delete none.CONVERSATION_EVENTS;
    expect(await flushConversationEvents(none)).toBe(0);
    expect((await outbox()).map((e) => e.sent)).toEqual([false]);

    const queue = fakeQueue();
    expect(await flushConversationEvents({ ...env, CONVERSATION_EVENTS: queue })).toBe(1);
    expect(queue.sent).toEqual([
      expect.objectContaining({ type: "conversation.members_removed", conversationId: c.id, accountIds: [DAD] }),
    ]);
    expect((await outbox()).map((e) => e.sent)).toEqual([true]);
    // Sent rows are not sent again.
    expect(await flushConversationEvents({ ...env, CONVERSATION_EVENTS: queue })).toBe(0);
    expect(queue.sent).toHaveLength(1);
  });

  it("the cron flushes what is pending and purges rows sent more than 7 days ago", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO conversation_outbox (body, created_at, sent_at) VALUES (?1, ?2, ?3)").bind(
        JSON.stringify({ v: 1, id: "old", type: "conversation.closed", conversationId: "c_old", occurredAt: "x" }),
        1,
        Date.now() - 8 * 24 * 60 * 60 * 1000,
      ),
      env.DB.prepare("INSERT INTO conversation_outbox (body, created_at, sent_at) VALUES (?1, ?2, NULL)").bind(
        JSON.stringify({ v: 1, id: "new", type: "conversation.closed", conversationId: "c_new", occurredAt: "x" }),
        2,
      ),
    ]);
    await worker.scheduled({} as ScheduledController, env);
    const rows = await outbox();
    expect(rows.map((e) => [e.id, e.sent])).toEqual([["new", true]]);
    await purgeConversationOutbox(env, Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(await outbox()).toEqual([]);
  });
});
