// Conversation events for the calls service, through a Cloudflare Queue (binding CONVERSATION_EVENTS, producer only;
// queue zapakid-conversation-events-<env>; schema: ConversationEvent in openapi.yaml, the same in
// services/calls/openapi.yaml). When chat removes a member from a conversation, or closes one, the calls service
// drops that member's devices from a live call (api #77). Transactional outbox, as the account service's membership
// events: the event row goes in the same D1 batch as the change, so an event exists if and only if the change
// happened. flushConversationEvents() sends unsent rows in order right after the change and again from the cron.
// Delivery is at least once; the calls service's handling is idempotent (removing an absent member is a no-op).
import type { Env } from "./env";

export type ConversationEvent = { v: 1; id: string; occurredAt: string } & (
  | { type: "conversation.members_removed"; conversationId: string; accountIds: string[] }
  | { type: "conversation.closed"; conversationId: string }
);

type EventData = ConversationEvent extends infer E
  ? E extends unknown
    ? Omit<E, "v" | "id" | "occurredAt">
    : never
  : never;

const BATCH = 100;
const SENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// The outbox insert for one event, to put in the change's D1 batch.
export function conversationEvent(env: Env, event: EventData, now = Date.now()): D1PreparedStatement {
  const body = JSON.stringify({ v: 1, id: crypto.randomUUID(), ...event, occurredAt: new Date(now).toISOString() });
  return env.DB.prepare("INSERT INTO conversation_outbox (body, created_at) VALUES (?1, ?2)").bind(body, now);
}

// Sends unsent events in order and marks them sent. Returns how many were sent. Never throws: a missing binding or
// a failing queue leaves the events for the next flush (the hourly cron).
export async function flushConversationEvents(env: Env): Promise<number> {
  const queue = env.CONVERSATION_EVENTS;
  if (!queue) return 0;
  let total = 0;
  try {
    for (;;) {
      const { results } = await env.DB.prepare(
        "SELECT seq, body FROM conversation_outbox WHERE sent_at IS NULL ORDER BY seq LIMIT ?1",
      )
        .bind(BATCH)
        .all<{ seq: number; body: string }>();
      if (results.length === 0) break;
      await queue.sendBatch(
        results.map((r) => ({ body: JSON.parse(r.body) as ConversationEvent, contentType: "json" as const })),
      );
      const last = results[results.length - 1]?.seq ?? 0;
      await env.DB.prepare("UPDATE conversation_outbox SET sent_at = ?1 WHERE sent_at IS NULL AND seq <= ?2")
        .bind(Date.now(), last)
        .run();
      total += results.length;
      if (results.length < BATCH) break;
    }
  } catch (e) {
    console.error(JSON.stringify({ msg: "conversation events not sent", err: String(e) }));
  }
  return total;
}

export async function purgeConversationOutbox(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM conversation_outbox WHERE sent_at IS NOT NULL AND sent_at < ?1")
    .bind(now - SENT_RETENTION_MS)
    .run();
}
