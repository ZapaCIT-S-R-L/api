// Membership events for the chat and calls services, through a Cloudflare Queue (binding MEMBERSHIP_EVENTS, producer
// only; queue zapakid-membership-<env>). The contract is the chat service's: MembershipEvent in openapi.yaml (same
// as services/chat/openapi.yaml). Transactional outbox: the event row is written in the same D1 batch as the change,
// so an event exists if and only if the change happened. flushMembershipEvents() sends unsent rows in outbox order
// right after the change and again from the cron. Delivery is at least once: consumers dedupe by `id`.
import type { Env } from "./env";

export type MembershipEvent = { v: 1; id: string; occurredAt: string } & (
  | { type: "family.member_added"; familyId: string; accountId: string; role: "parent" | "kid" }
  | { type: "family.member_removed"; familyId: string; accountId: string }
  | { type: "device.removed"; accountId: string; deviceId: number }
  // POST /v1/auth/logout-all: chat tokens with a `sep` claim below `epoch` are revoked (api #81).
  | { type: "account.sessions_revoked"; accountId: string; epoch: number }
  | { type: "connection.created"; connectionId: string; familyIds: [string, string] }
  | { type: "connection.removed"; connectionId: string }
  | { type: "connection.kid_shared"; connectionId: string; kidAccountId: string }
  | { type: "connection.kid_unshared"; connectionId: string; kidAccountId: string }
);

type EventData = MembershipEvent extends infer E
  ? E extends unknown
    ? Omit<E, "v" | "id" | "occurredAt">
    : never
  : never;

const BATCH = 100;
export const SENT_RETENTION_DAYS = 7;

// The outbox insert for one event, to put in the change's D1 batch. `onlyIf` is an SQL condition (with its binds)
// evaluated in the same transaction: the event is written only when the change it describes happened.
export function membershipEvent(
  env: Env,
  event: EventData,
  onlyIf?: { sql: string; binds: unknown[] },
): D1PreparedStatement {
  const now = new Date().toISOString();
  const body = JSON.stringify({ v: 1, id: crypto.randomUUID(), ...event, occurredAt: now });
  const where = onlyIf ? ` WHERE ${onlyIf.sql}` : "";
  return env.DB.prepare(`INSERT INTO membership_outbox (body, created_at) SELECT ?, ?${where}`).bind(
    body,
    now,
    ...(onlyIf?.binds ?? []),
  );
}

// The outbox insert for an account.sessions_revoked event, to put in the batch right after the statement that
// increments parents.session_epoch: `epoch` is read from the row in the same transaction, so the event always
// carries the epoch the increment produced.
export function sessionsRevokedEvent(env: Env, accountId: string): D1PreparedStatement {
  const now = new Date().toISOString();
  const body = JSON.stringify({
    v: 1,
    id: crypto.randomUUID(),
    type: "account.sessions_revoked",
    accountId,
    epoch: 0,
    occurredAt: now,
  });
  return env.DB.prepare(
    "INSERT INTO membership_outbox (body, created_at) SELECT json_set(?, '$.epoch', session_epoch), ? FROM parents WHERE id = ?",
  ).bind(body, now, accountId);
}

// Sends unsent events in order and marks them sent. Returns how many were sent. Never throws: a missing binding or
// a failing queue leaves the events for the next flush.
export async function flushMembershipEvents(env: Env): Promise<number> {
  const queue = env.MEMBERSHIP_EVENTS;
  if (!queue) return 0;
  let total = 0;
  try {
    for (;;) {
      const { results } = await env.DB.prepare(
        "SELECT seq, body FROM membership_outbox WHERE sent_at IS NULL ORDER BY seq LIMIT ?",
      )
        .bind(BATCH)
        .all<{ seq: number; body: string }>();
      if (results.length === 0) break;
      await queue.sendBatch(
        results.map((r) => ({ body: JSON.parse(r.body) as MembershipEvent, contentType: "json" as const })),
      );
      const last = results[results.length - 1]?.seq ?? 0;
      await env.DB.prepare("UPDATE membership_outbox SET sent_at = ? WHERE sent_at IS NULL AND seq <= ?")
        .bind(new Date().toISOString(), last)
        .run();
      total += results.length;
      if (results.length < BATCH) break;
    }
  } catch (e) {
    console.error(JSON.stringify({ msg: "membership events not sent", err: String(e) }));
  }
  return total;
}
