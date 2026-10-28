// Conversations: 1:1 (direct) and group chats between accounts. Metadata only; content lives encrypted on the
// phones and, until delivered, as delivery copies in the conversation's Durable Object.
//
// Members are either writers (the accounts the conversation was started with) or observers: the current parents of
// every kid in it, added by the server (api #73). Observers receive every envelope like any member, so they read
// the whole chat on their own devices, but they can't send, they aren't in calls and they get no push. The column
// is still called `guardian` (migration 0001); `guardian = 1` is an observer.
import type { Caller } from "./auth";
import { ACCOUNT_ID, CONVERSATION_ID, onlyFields, randomId, readJson } from "./body";
import type { Env } from "./env";
import { allowedTogether, contactsOf, loadFamilies, missingObservers, observersOf, roleOf, type Role } from "./graph";
import { empty, HttpError, invalid, json, notAllowed, notFound } from "./http";
import { purgeConversationAttachments } from "./attachments";
import { limit } from "./limits";
import type { Rooms } from "./rooms";

export const MAX_REQUESTED_MEMBERS = 31;
// Writers; observers have their own limit and don't count here, so a group of kids isn't blocked by its parents.
export const MAX_MEMBERS = 64;
export const MAX_OBSERVERS = 64;

export type MemberRole = Role | "observer";

export interface MemberRow {
  account_id: string;
  role: Role;
  guardian: number;
  deleted_at: number | null;
}

export const isObserver = (m: Pick<MemberRow, "guardian">): boolean => m.guardian === 1;

// An observer may read, acknowledge and stream, never send (messages, reactions, attachments).
export function assertWriter(me: Pick<MemberRow, "guardian">): void {
  if (isObserver(me)) {
    throw new HttpError(403, "observer_read_only", "You read this conversation as a parent; you can't send to it.");
  }
}

interface ConversationRow {
  id: string;
  kind: "direct" | "group";
  state: "open" | "closed";
  created_at: number;
  closed_at: number | null;
}

export interface Device {
  deviceId: number;
  registrationId: number;
}

export async function membersOf(env: Env, conversationId: string): Promise<MemberRow[]> {
  const rows = await env.DB.prepare(
    "SELECT account_id, role, guardian, deleted_at FROM conversation_members WHERE conversation_id = ?1 ORDER BY joined_at, account_id",
  )
    .bind(conversationId)
    .all<MemberRow>();
  return rows.results;
}

export async function devicesOf(env: Env, accountIds: string[]): Promise<Map<string, Device[]>> {
  const devices = new Map<string, Device[]>();
  if (accountIds.length === 0) return devices;
  const rows = await env.DB.prepare(
    `SELECT account_id, device_id, registration_id FROM devices
     WHERE account_id IN (SELECT value FROM json_each(?1)) ORDER BY account_id, device_id`,
  )
    .bind(JSON.stringify(accountIds))
    .all<{ account_id: string; device_id: number; registration_id: number }>();
  for (const row of rows.results) {
    const list = devices.get(row.account_id) ?? [];
    list.push({ deviceId: row.device_id, registrationId: row.registration_id });
    devices.set(row.account_id, list);
  }
  return devices;
}

// The conversation if the caller's account is a member that hasn't deleted it, else 404.
export async function requireMembership(
  env: Env,
  caller: Pick<Caller, "accountId">,
  conversationId: string,
): Promise<{ conversation: ConversationRow; members: MemberRow[]; me: MemberRow }> {
  if (!CONVERSATION_ID.test(conversationId)) throw notFound();
  const conversation = await env.DB.prepare(
    "SELECT id, kind, state, created_at, closed_at FROM conversations WHERE id = ?1",
  )
    .bind(conversationId)
    .first<ConversationRow>();
  if (!conversation) throw notFound();
  const members = await membersOf(env, conversationId);
  const me = members.find((m) => m.account_id === caller.accountId);
  if (!me || me.deleted_at !== null) throw notFound();
  return { conversation, members, me };
}

async function present(env: Env, conversation: ConversationRow, members: MemberRow[]) {
  const devices = await devicesOf(
    env,
    members.map((m) => m.account_id),
  );
  return {
    id: conversation.id,
    kind: conversation.kind,
    state: conversation.state,
    createdAt: new Date(conversation.created_at).toISOString(),
    closedAt: conversation.closed_at === null ? null : new Date(conversation.closed_at).toISOString(),
    members: members.map((m) => ({
      accountId: m.account_id,
      role: (isObserver(m) ? "observer" : m.role) satisfies MemberRole,
      // Deprecated alias of role "observer", kept for the apps built against the first contract.
      guardian: isObserver(m),
      devices: devices.get(m.account_id) ?? [],
    })),
  };
}

export async function handleCreate(request: Request, env: Env, caller: Caller): Promise<Response> {
  await limit(env.CREATE_LIMITER, `create:${caller.accountId}`);
  const body = await readJson(request);
  onlyFields(body, ["members"]);
  const { members } = body;
  if (
    !Array.isArray(members) ||
    members.length < 1 ||
    members.length > MAX_REQUESTED_MEMBERS ||
    !members.every((m): m is string => typeof m === "string" && ACCOUNT_ID.test(m))
  ) {
    throw invalid(`members: 1 to ${MAX_REQUESTED_MEMBERS} account ids.`);
  }
  if (new Set(members).size !== members.length) throw invalid("members: duplicates.");
  if (members.includes(caller.accountId)) throw invalid("members: list the other accounts, not yourself.");

  const requested = [caller.accountId, ...members];
  const graph = await loadFamilies(env, requested);
  // Parents and kids both start conversations (Stefan, 2026-10-28). Who may be in one is decided by the family
  // graph below, and every kid's parents observe it (unless oversight is off), so a kid can't reach anyone a
  // parent hasn't allowed, and the parents can read what is said.
  if (requested.some((a) => !graph.of.has(a))) throw notAllowed("Not allowed with these members.");
  const observers = missingObservers(graph, requested);
  if (requested.length > MAX_MEMBERS) throw invalid(`At most ${MAX_MEMBERS} members.`);
  if (observers.length > MAX_OBSERVERS) throw invalid(`At most ${MAX_OBSERVERS} observing parents.`);
  const all = [...requested, ...observers];
  if (!allowedTogether(graph, all)) throw notAllowed("Not allowed with these members.");

  const kind = members.length === 1 ? "direct" : "group";
  const directKey = kind === "direct" ? [...requested].sort().join(" ") : null;
  if (directKey) {
    const existing = await env.DB.prepare(
      `SELECT c.id, c.kind, c.state, c.created_at, c.closed_at FROM conversations c
       JOIN conversation_members m ON m.conversation_id = c.id AND m.account_id = ?2
       WHERE c.direct_key = ?1 AND c.state = 'open' AND m.deleted_at IS NULL LIMIT 1`,
    )
      .bind(directKey, caller.accountId)
      .first<ConversationRow>();
    if (existing) return json(await present(env, existing, await membersOf(env, existing.id)), 200);
  }

  const id = randomId("c");
  const now = Date.now();
  const observerSet = new Set(observers);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO conversations (id, kind, direct_key, state, created_by, created_at) VALUES (?1, ?2, ?3, 'open', ?4, ?5)",
    ).bind(id, kind, directKey, caller.accountId, now),
    ...all.map((account) =>
      env.DB.prepare(
        "INSERT INTO conversation_members (conversation_id, account_id, role, guardian, joined_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      ).bind(id, account, roleOf(graph, account), observerSet.has(account) ? 1 : 0, now),
    ),
  ]);
  const conversation: ConversationRow = { id, kind, state: "open", created_at: now, closed_at: null };
  return json(await present(env, conversation, await membersOf(env, id)), 201);
}

export async function handleList(_request: Request, env: Env, caller: Caller): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT c.id, c.kind, c.state, c.created_at, c.closed_at FROM conversations c
     JOIN conversation_members m ON m.conversation_id = c.id
     WHERE m.account_id = ?1 AND m.deleted_at IS NULL ORDER BY c.created_at DESC LIMIT 500`,
  )
    .bind(caller.accountId)
    .all<ConversationRow>();
  const conversations = [];
  for (const row of rows.results) conversations.push(await present(env, row, await membersOf(env, row.id)));
  return json({ conversations });
}

export async function handleGet(env: Env, caller: Caller, conversationId: string): Promise<Response> {
  const { conversation, members } = await requireMembership(env, caller, conversationId);
  return json(await present(env, conversation, members));
}

// Discovery (api #73): the accounts the caller may start a conversation with, ids only.
export async function handleContacts(env: Env, caller: Caller): Promise<Response> {
  return json({ contacts: await contactsOf(env, caller.accountId) });
}

export async function handleDelete(env: Env, rooms: Rooms, caller: Caller, conversationId: string): Promise<Response> {
  await requireMembership(env, caller, conversationId);
  await env.DB.prepare("UPDATE conversation_members SET deleted_at = ?3 WHERE conversation_id = ?1 AND account_id = ?2")
    .bind(conversationId, caller.accountId, Date.now())
    .run();
  await rooms.forgetAccount(conversationId, caller.accountId);
  await purgeIfAbandoned(env, rooms, conversationId);
  return empty();
}

// Retention: once every member has deleted the conversation (or left), nothing about it is kept.
export async function purgeIfAbandoned(env: Env, rooms: Rooms, conversationId: string): Promise<boolean> {
  const remaining = await env.DB.prepare(
    "SELECT count(*) AS n FROM conversation_members WHERE conversation_id = ?1 AND deleted_at IS NULL",
  )
    .bind(conversationId)
    .first<{ n: number }>();
  if ((remaining?.n ?? 0) > 0) return false;
  await rooms.purge(conversationId);
  await purgeConversationAttachments(env, conversationId);
  await env.DB.prepare("DELETE FROM conversations WHERE id = ?1").bind(conversationId).run();
  return true;
}

// Re-applies the family rules to a conversation after the family graph changed:
//   1. members who are in no family any more (left, deleted) are removed;
//   2. observers who no longer observe a kid in it (not its parent any more, or oversight turned off) are removed;
//      the missing observers of the kids in it are added (new parent, oversight turned back on);
//   3. if members from different families are no longer allowed together (connection removed, kid unshared), or
//      fewer than two writers remain, the conversation is closed (read-only).
// The conversation's devices get an event so they refresh the member list and rotate their sender keys. When
// observers are added, the kid's own device re-seals the history to them: the server has nothing it could send.
export async function reconcile(env: Env, rooms: Rooms, conversationId: string): Promise<void> {
  const conversation = await env.DB.prepare("SELECT state FROM conversations WHERE id = ?1")
    .bind(conversationId)
    .first<{ state: "open" | "closed" }>();
  if (!conversation) return;
  const members = await membersOf(env, conversationId);
  const graph = await loadFamilies(
    env,
    members.map((m) => m.account_id),
  );
  const removed: string[] = [];
  for (const m of members) {
    if (!graph.of.has(m.account_id)) removed.push(m.account_id);
  }
  const writers = members.filter((m) => !isObserver(m) && !removed.includes(m.account_id)).map((m) => m.account_id);
  const observers = observersOf(graph, writers);
  for (const m of members) {
    if (!isObserver(m) || removed.includes(m.account_id)) continue;
    if (!observers.has(m.account_id)) removed.push(m.account_id);
  }
  const current = members.map((m) => m.account_id).filter((a) => !removed.includes(a));
  const added = conversation.state === "open" ? missingObservers(graph, current) : [];

  const now = Date.now();
  const statements = [
    ...removed.map((a) =>
      env.DB.prepare("DELETE FROM conversation_members WHERE conversation_id = ?1 AND account_id = ?2").bind(
        conversationId,
        a,
      ),
    ),
    ...added.map((a) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO conversation_members (conversation_id, account_id, role, guardian, joined_at) VALUES (?1, ?2, ?3, 1, ?4)",
      ).bind(conversationId, a, roleOf(graph, a), now),
    ),
  ];
  const after = [...current, ...added];
  const close = conversation.state === "open" && (writers.length < 2 || !allowedTogether(graph, after));
  if (close) {
    statements.push(
      env.DB.prepare("UPDATE conversations SET state = 'closed', closed_at = ?2 WHERE id = ?1").bind(
        conversationId,
        now,
      ),
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);
  for (const account of removed) await rooms.forgetAccount(conversationId, account);
  if (await purgeIfAbandoned(env, rooms, conversationId)) return;
  if (removed.length > 0 || added.length > 0) await rooms.notify(conversationId, "members_changed", removed);
  if (close) await rooms.notify(conversationId, "conversation_closed", []);
}

// Conversations any of these accounts is a member of.
export async function conversationsOf(env: Env, accountIds: string[]): Promise<string[]> {
  if (accountIds.length === 0) return [];
  const rows = await env.DB.prepare(
    `SELECT DISTINCT conversation_id FROM conversation_members WHERE account_id IN (SELECT value FROM json_each(?1))`,
  )
    .bind(JSON.stringify([...new Set(accountIds)]))
    .all<{ conversation_id: string }>();
  return rows.results.map((r) => r.conversation_id);
}

export function assertOpen(conversation: { state: string }): void {
  if (conversation.state !== "open") {
    throw new HttpError(403, "conversation_closed", "This conversation is read-only.");
  }
}
