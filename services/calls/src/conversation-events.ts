// Conversation events from the chat service (Cloudflare Queue zapakid-conversation-events-<env>; schema:
// ConversationEvent in openapi.yaml, the same as services/chat/openapi.yaml). When chat removes members from a
// conversation, or closes it, the live calls of that conversation drop those members' devices at once: the call
// room closes their events sockets, rotates the key epoch without them (src/call-room.ts) and this consumer closes
// their SFU tracks. Without the event they would stay in the call until they left (api #77): since #76 they can't
// rejoin or open a new SFU session, but their running session keeps going.
//
// Idempotent by nature: removing a member who is not in the call is a no-op, so repeated delivery needs no dedupe.
import type { Env } from "./env";
import { limits } from "./limits";
import { closeSession, RealtimeRejected, RealtimeUnavailable } from "./realtime";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Conversation and account ids, as the HTTP API accepts them (src/body.ts, `Id` in openapi.yaml).
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_ACCOUNTS = 64;
// Live calls of a conversation looked at per event; a conversation has at most one live call in practice.
const MAX_CALLS = 20;

export type ConversationEvent = { v: 1; id: string; occurredAt: string; conversationId: string } & (
  { type: "conversation.members_removed"; accountIds: string[] } | { type: "conversation.closed" }
);

export class MalformedEvent extends Error {}

const str = (v: unknown, re = ID): v is string => typeof v === "string" && re.test(v);

// The event, null for an unknown type (ignored: newer producer), or MalformedEvent.
export function parseEvent(value: unknown): ConversationEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new MalformedEvent("not an object");
  const e = value as Record<string, unknown>;
  if (e.v !== 1 || !str(e.id, UUID) || typeof e.occurredAt !== "string" || typeof e.type !== "string") {
    throw new MalformedEvent("missing v, id, occurredAt or type");
  }
  const base = { v: 1 as const, id: e.id, occurredAt: e.occurredAt };
  switch (e.type) {
    case "conversation.members_removed": {
      const ids = e.accountIds;
      if (!str(e.conversationId) || !Array.isArray(ids) || ids.length === 0 || ids.length > MAX_ACCOUNTS) {
        throw new MalformedEvent("invalid conversation.members_removed");
      }
      if (!ids.every((a) => str(a))) throw new MalformedEvent("invalid conversation.members_removed");
      return { ...base, type: e.type, conversationId: e.conversationId, accountIds: [...new Set(ids)] };
    }
    case "conversation.closed":
      if (!str(e.conversationId)) throw new MalformedEvent("invalid conversation.closed");
      return { ...base, type: e.type, conversationId: e.conversationId };
    default:
      return null;
  }
}

// The calls of a conversation that have not ended (within the maximum call duration, as POST /v1/calls looks).
async function liveCalls(env: Env, conversationId: string): Promise<string[]> {
  const since = new Date(Date.now() - limits(env).maxCallSeconds * 1000).toISOString();
  const rows = await env.DB.prepare(
    "SELECT id FROM calls WHERE conversation_id = ?1 AND ended_at IS NULL AND created_at > ?2 ORDER BY created_at DESC LIMIT ?3",
  )
    .bind(conversationId, since, MAX_CALLS)
    .all<{ id: string }>();
  return rows.results.map((r) => r.id);
}

// Applies one event to the live calls of its conversation. The call room drops the members first (their key epoch
// is over from that moment); closing their SFU tracks is clean-up and best effort: a removed device can't decrypt
// the rotated call key, and the phone drops its session when its events socket closes.
export async function applyEvent(env: Env, event: ConversationEvent): Promise<void> {
  for (const callId of await liveCalls(env, event.conversationId)) {
    const room = env.CALL.get(env.CALL.idFromName(callId));
    const sessions =
      event.type === "conversation.closed"
        ? await room.conversationClosed()
        : await room.removeMembers(event.accountIds);
    for (const sessionId of sessions) {
      try {
        await closeSession(env, sessionId);
      } catch (e) {
        if (!(e instanceof RealtimeUnavailable || e instanceof RealtimeRejected)) throw e;
        console.error(JSON.stringify({ msg: "sfu session not closed", callId, err: e.message }));
      }
    }
  }
}

// Queue consumer. Unknown types are acknowledged; malformed events are retried and end in the dead-letter queue,
// where they can be inspected (ids only, no content). A failure (D1, the call room) retries the message.
export async function consumeConversationEvents(batch: MessageBatch, env: Env): Promise<void> {
  for (const message of batch.messages) {
    let event: ConversationEvent | null;
    try {
      event = parseEvent(message.body);
    } catch (e) {
      console.error(JSON.stringify({ msg: "conversation_event_malformed", err: String(e) }));
      message.retry();
      continue;
    }
    if (!event) {
      message.ack();
      continue;
    }
    try {
      await applyEvent(env, event);
      message.ack();
    } catch (e) {
      console.error(JSON.stringify({ msg: "conversation_event_failed", type: event.type, err: String(e) }));
      message.retry();
    }
  }
}
