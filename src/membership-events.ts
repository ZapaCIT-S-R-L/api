// Membership events for the chat and calls services, through a Cloudflare Queue (binding MEMBERSHIP_EVENTS, producer
// only). Transactional outbox: the event row is written in the same D1 batch as the change, so an event exists if
// and only if the change happened. flushMembershipEvents() sends unsent rows in seq order right after the change and
// again from the cron. Delivery is at least once: consumers dedupe by `id` and order by `seq` per scope.
// Schema: components/schemas/MembershipEvent in openapi.yaml.
import type { Env } from "./env";
import type { Role } from "./family-membership";

export type MembershipEventType = "member.added" | "member.removed" | "scope.deleted";

export interface MembershipEvent {
  version: 1;
  id: string;
  seq: number;
  type: MembershipEventType;
  scope: string;
  familyId: string;
  // The account added or removed; absent for scope.deleted (everyone in it is removed).
  account?: { id: string; role: Role };
  occurredAt: string;
}

const BATCH = 100;
export const SENT_RETENTION_DAYS = 7;

// The outbox insert for one event, to put in the change's D1 batch. `onlyIf` is an SQL condition (with its binds)
// evaluated in the same transaction: the event is written only when the change it describes happened.
export function membershipEvent(
  env: Env,
  event: Omit<MembershipEvent, "version" | "id" | "seq" | "occurredAt">,
  onlyIf?: { sql: string; binds: unknown[] },
): D1PreparedStatement {
  const now = new Date().toISOString();
  const body = JSON.stringify({ version: 1, id: crypto.randomUUID(), ...event, occurredAt: now });
  const where = onlyIf ? ` WHERE ${onlyIf.sql}` : "";
  return env.DB.prepare(`INSERT INTO membership_outbox (body, created_at) SELECT ?, ?${where}`).bind(
    body,
    now,
    ...(onlyIf?.binds ?? []),
  );
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
        results.map((r) => ({
          body: { ...(JSON.parse(r.body) as Omit<MembershipEvent, "seq">), seq: r.seq },
          contentType: "json" as const,
        })),
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
