// Membership events from the account service (Cloudflare Queue zapakid-membership-<env>; schema: MembershipEvent
// in openapi.yaml). Each event updates the chat service's copy of the family graph, then the affected
// conversations are reconciled with the family rules (src/conversations.ts).
import { ACCOUNT_ID, isDeviceId, isRegistrationId, UUID } from "./body";
import { conversationsOf, reconcile } from "./conversations";
import type { Env } from "./env";
import type { Rooms } from "./rooms";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PROCESSED_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type MembershipEvent = { v: 1; id: string; occurredAt: string } & (
  | { type: "family.member_added"; familyId: string; accountId: string; role: "parent" | "kid" }
  | { type: "family.member_removed"; familyId: string; accountId: string }
  | { type: "connection.created"; connectionId: string; familyIds: [string, string] }
  | { type: "connection.removed"; connectionId: string }
  | { type: "connection.kid_shared"; connectionId: string; kidAccountId: string }
  | { type: "connection.kid_unshared"; connectionId: string; kidAccountId: string }
  | {
      type: "device.upserted";
      accountId: string;
      deviceId: number;
      registrationId: number;
      push?: { provider: "apns" | "fcm"; token: string } | null;
    }
  | { type: "device.removed"; accountId: string; deviceId: number }
  | { type: "account.deleted"; accountId: string }
  // The account signed out everywhere (api #81): chat tokens with a `sep` claim below `epoch` are refused.
  | { type: "account.sessions_revoked"; accountId: string; epoch: number }
);

export class MalformedEvent extends Error {}

const MAX_EPOCH = Number.MAX_SAFE_INTEGER;
const isEpoch = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_EPOCH;

// The epoch before which an account's chat tokens are revoked: 0 until its first logout-all.
export async function revokedBefore(env: Env, accountId: string): Promise<number> {
  const epoch = await env.DB.prepare("SELECT epoch FROM session_epochs WHERE account_id = ?1")
    .bind(accountId)
    .first<number>("epoch");
  return epoch ?? 0;
}

const str = (v: unknown, re = ID): v is string => typeof v === "string" && re.test(v);

// The event, null for an unknown type (ignored: newer producer), or MalformedEvent.
export function parseEvent(value: unknown): MembershipEvent | null {
  if (typeof value !== "object" || value === null) throw new MalformedEvent("not an object");
  const e = value as Record<string, unknown>;
  if (e.v !== 1 || !str(e.id, UUID) || typeof e.occurredAt !== "string" || typeof e.type !== "string") {
    throw new MalformedEvent("missing v, id, occurredAt or type");
  }
  const ok = (cond: boolean) => {
    if (!cond) throw new MalformedEvent(`invalid ${String(e.type)}`);
    return e as unknown as MembershipEvent;
  };
  switch (e.type) {
    case "family.member_added":
      return ok(str(e.familyId) && str(e.accountId, ACCOUNT_ID) && (e.role === "parent" || e.role === "kid"));
    case "family.member_removed":
      return ok(str(e.familyId) && str(e.accountId, ACCOUNT_ID));
    case "connection.created":
      return ok(
        str(e.connectionId) &&
          Array.isArray(e.familyIds) &&
          e.familyIds.length === 2 &&
          e.familyIds.every((f) => str(f)) &&
          e.familyIds[0] !== e.familyIds[1],
      );
    case "connection.removed":
      return ok(str(e.connectionId));
    case "connection.kid_shared":
    case "connection.kid_unshared":
      return ok(str(e.connectionId) && str(e.kidAccountId, ACCOUNT_ID));
    case "device.upserted": {
      const push = e.push as { provider?: unknown; token?: unknown } | null | undefined;
      const pushOk =
        push === undefined ||
        push === null ||
        ((push.provider === "apns" || push.provider === "fcm") &&
          typeof push.token === "string" &&
          push.token.length > 0 &&
          push.token.length <= 4096);
      return ok(str(e.accountId, ACCOUNT_ID) && isDeviceId(e.deviceId) && isRegistrationId(e.registrationId) && pushOk);
    }
    case "device.removed":
      return ok(str(e.accountId, ACCOUNT_ID) && isDeviceId(e.deviceId));
    case "account.deleted":
      return ok(str(e.accountId, ACCOUNT_ID));
    case "account.sessions_revoked":
      return ok(str(e.accountId, ACCOUNT_ID) && isEpoch(e.epoch));
    default:
      return null;
  }
}

async function familyAccounts(env: Env, familyIds: string[]): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT DISTINCT account_id FROM family_members WHERE family_id IN (SELECT value FROM json_each(?1))",
  )
    .bind(JSON.stringify(familyIds))
    .all<{ account_id: string }>();
  return rows.results.map((r) => r.account_id);
}

async function connectionFamilies(env: Env, connectionId: string): Promise<string[]> {
  const row = await env.DB.prepare("SELECT family_a, family_b FROM connections WHERE id = ?1")
    .bind(connectionId)
    .first<{ family_a: string; family_b: string }>();
  return row ? [row.family_a, row.family_b] : [];
}

async function reconcileAll(env: Env, rooms: Rooms, conversationIds: string[]): Promise<void> {
  for (const id of new Set(conversationIds)) await reconcile(env, rooms, id);
}

// Applies one event. Safe to apply again (each event carries the full state of what it describes).
export async function applyEvent(env: Env, rooms: Rooms, event: MembershipEvent): Promise<void> {
  const db = env.DB;
  switch (event.type) {
    case "family.member_added": {
      await db
        .prepare("INSERT OR REPLACE INTO family_members (family_id, account_id, role) VALUES (?1, ?2, ?3)")
        .bind(event.familyId, event.accountId, event.role)
        .run();
      // A new parent joins the conversations of the family's kids.
      await reconcileAll(env, rooms, await conversationsOf(env, await familyAccounts(env, [event.familyId])));
      return;
    }
    case "family.member_removed": {
      const affected = await conversationsOf(env, [event.accountId, ...(await familyAccounts(env, [event.familyId]))]);
      await db
        .prepare("DELETE FROM family_members WHERE family_id = ?1 AND account_id = ?2")
        .bind(event.familyId, event.accountId)
        .run();
      await reconcileAll(env, rooms, affected);
      return;
    }
    case "connection.created": {
      const [a, b] = [...event.familyIds].sort() as [string, string];
      await db
        .prepare("INSERT OR IGNORE INTO connections (id, family_a, family_b) VALUES (?1, ?2, ?3)")
        .bind(event.connectionId, a, b)
        .run();
      return;
    }
    case "connection.removed": {
      const families = await connectionFamilies(env, event.connectionId);
      const affected = await conversationsOf(env, await familyAccounts(env, families));
      await db.batch([
        db.prepare("DELETE FROM shared_kids WHERE connection_id = ?1").bind(event.connectionId),
        db.prepare("DELETE FROM connections WHERE id = ?1").bind(event.connectionId),
      ]);
      await reconcileAll(env, rooms, affected);
      return;
    }
    case "connection.kid_shared":
      await db
        .prepare("INSERT OR IGNORE INTO shared_kids (connection_id, kid_account_id) VALUES (?1, ?2)")
        .bind(event.connectionId, event.kidAccountId)
        .run();
      return;
    case "connection.kid_unshared":
      await db
        .prepare("DELETE FROM shared_kids WHERE connection_id = ?1 AND kid_account_id = ?2")
        .bind(event.connectionId, event.kidAccountId)
        .run();
      await reconcileAll(env, rooms, await conversationsOf(env, [event.kidAccountId]));
      return;
    case "device.upserted": {
      await db
        .prepare(
          `INSERT INTO devices (account_id, device_id, registration_id, push_provider, push_token)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (account_id, device_id) DO UPDATE SET registration_id = ?3, push_provider = ?4, push_token = ?5`,
        )
        .bind(
          event.accountId,
          event.deviceId,
          event.registrationId,
          event.push?.provider ?? null,
          event.push?.token ?? null,
        )
        .run();
      for (const id of await conversationsOf(env, [event.accountId])) await rooms.notify(id, "devices_changed", []);
      return;
    }
    case "device.removed": {
      await db
        .prepare("DELETE FROM devices WHERE account_id = ?1 AND device_id = ?2")
        .bind(event.accountId, event.deviceId)
        .run();
      for (const id of await conversationsOf(env, [event.accountId])) {
        await rooms.forgetDevice(id, event.accountId, event.deviceId);
        await rooms.notify(id, "devices_changed", []);
      }
      return;
    }
    case "account.deleted": {
      const affected = await conversationsOf(env, [event.accountId]);
      await db.batch([
        db.prepare("DELETE FROM family_members WHERE account_id = ?1").bind(event.accountId),
        db.prepare("DELETE FROM shared_kids WHERE kid_account_id = ?1").bind(event.accountId),
        db.prepare("DELETE FROM devices WHERE account_id = ?1").bind(event.accountId),
        db.prepare("DELETE FROM session_epochs WHERE account_id = ?1").bind(event.accountId),
      ]);
      await reconcileAll(env, rooms, affected);
      return;
    }
    case "account.sessions_revoked": {
      // Epochs only grow (events may arrive out of order): keep the highest, then close the streams opened with
      // tokens from before it. Requests with such tokens are refused from now on (src/auth.ts).
      await db
        .prepare(
          `INSERT INTO session_epochs (account_id, epoch) VALUES (?1, ?2)
           ON CONFLICT (account_id) DO UPDATE SET epoch = max(epoch, excluded.epoch)`,
        )
        .bind(event.accountId, event.epoch)
        .run();
      const epoch = await revokedBefore(env, event.accountId);
      for (const id of await conversationsOf(env, [event.accountId])) {
        await rooms.revokeSessions(id, event.accountId, epoch);
      }
      return;
    }
  }
}

// Queue consumer. A repeated event id is a no-op. Unknown types are acknowledged; malformed events are retried and
// end in the dead-letter queue, where they can be inspected (they hold ids only, no content).
export async function consume(batch: MessageBatch, env: Env, rooms: Rooms): Promise<void> {
  for (const message of batch.messages) {
    let event: MembershipEvent | null;
    try {
      event = parseEvent(message.body);
    } catch (e) {
      console.error(JSON.stringify({ msg: "membership_event_malformed", err: String(e) }));
      message.retry();
      continue;
    }
    if (!event) {
      message.ack();
      continue;
    }
    const seen = await env.DB.prepare("SELECT 1 FROM processed_events WHERE id = ?1").bind(event.id).first();
    if (seen) {
      message.ack();
      continue;
    }
    try {
      await applyEvent(env, rooms, event);
      await env.DB.prepare("INSERT OR IGNORE INTO processed_events (id, processed_at) VALUES (?1, ?2)")
        .bind(event.id, Date.now())
        .run();
      message.ack();
    } catch (e) {
      console.error(JSON.stringify({ msg: "membership_event_failed", type: event.type, err: String(e) }));
      message.retry();
    }
  }
}

export async function purgeProcessedEvents(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM processed_events WHERE processed_at < ?1")
    .bind(now - PROCESSED_TTL_MS)
    .run();
}
