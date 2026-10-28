// The family rules, on the chat service's copy of the family graph (D1, fed by membership events):
//   - every conversation with a kid includes the current parents of the kid's family as observers (read-only,
//     never in calls), unless the family turned oversight off for that kid (api #73);
//   - two members from different families need a connection between their families, and a kid needs to be shared
//     through it;
//   - parents and kids start conversations.
// reconcile() re-applies them to a conversation after the graph changed.
import type { Env } from "./env";

export type Role = "parent" | "kid";

export interface Families {
  // account id → its families and its role in each
  of: Map<string, { familyId: string; role: Role }[]>;
  // "familyA familyB" (sorted) → connection ids
  connections: Map<string, string[]>;
  // connection id → shared kid account ids
  shared: Map<string, Set<string>>;
  // family id → parent account ids
  parents: Map<string, string[]>;
  // kids whose family turned parent oversight off (default: on)
  oversightOff: Set<string>;
}

const pairKey = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);

// The graph around the given accounts: their families, those families' parents, and the connections between them.
export async function loadFamilies(env: Env, accountIds: string[]): Promise<Families> {
  const of = new Map<string, { familyId: string; role: Role }[]>();
  const parents = new Map<string, string[]>();
  const connections = new Map<string, string[]>();
  const shared = new Map<string, Set<string>>();
  const oversightOff = new Set<string>();
  if (accountIds.length === 0) return { of, connections, shared, parents, oversightOff };

  const ids = JSON.stringify([...new Set(accountIds)]);
  const memberships = await env.DB.prepare(
    `SELECT family_id, account_id, role FROM family_members
     WHERE family_id IN (SELECT family_id FROM family_members WHERE account_id IN (SELECT value FROM json_each(?1)))`,
  )
    .bind(ids)
    .all<{ family_id: string; account_id: string; role: Role }>();
  const familyIds = new Set<string>();
  const kids: string[] = [];
  for (const row of memberships.results) {
    familyIds.add(row.family_id);
    const list = of.get(row.account_id) ?? [];
    list.push({ familyId: row.family_id, role: row.role });
    of.set(row.account_id, list);
    if (row.role === "parent") parents.set(row.family_id, [...(parents.get(row.family_id) ?? []), row.account_id]);
    else kids.push(row.account_id);
  }
  if (kids.length > 0) {
    const rows = await env.DB.prepare(
      "SELECT kid_account_id FROM kid_oversight WHERE enabled = 0 AND kid_account_id IN (SELECT value FROM json_each(?1))",
    )
      .bind(JSON.stringify(kids))
      .all<{ kid_account_id: string }>();
    for (const row of rows.results) oversightOff.add(row.kid_account_id);
  }
  if (familyIds.size > 1) {
    const fams = JSON.stringify([...familyIds]);
    const rows = await env.DB.prepare(
      `SELECT c.id, c.family_a, c.family_b, s.kid_account_id FROM connections c
       LEFT JOIN shared_kids s ON s.connection_id = c.id
       WHERE c.family_a IN (SELECT value FROM json_each(?1)) AND c.family_b IN (SELECT value FROM json_each(?1))`,
    )
      .bind(fams)
      .all<{ id: string; family_a: string; family_b: string; kid_account_id: string | null }>();
    for (const row of rows.results) {
      const key = pairKey(row.family_a, row.family_b);
      const list = connections.get(key) ?? [];
      if (!list.includes(row.id)) list.push(row.id);
      connections.set(key, list);
      const kids = shared.get(row.id) ?? new Set<string>();
      if (row.kid_account_id) kids.add(row.kid_account_id);
      shared.set(row.id, kids);
    }
  }
  return { of, connections, shared, parents, oversightOff };
}

export function isParent(graph: Families, accountId: string): boolean {
  return (graph.of.get(accountId) ?? []).some((m) => m.role === "parent");
}

export function isKid(graph: Families, accountId: string): boolean {
  return (graph.of.get(accountId) ?? []).some((m) => m.role === "kid");
}

// The parents who observe `members`: the current parents of every kid in `members` whose oversight is on.
export function observersOf(graph: Families, members: string[]): Set<string> {
  const observers = new Set<string>();
  for (const account of members) {
    if (graph.oversightOff.has(account)) continue;
    for (const m of graph.of.get(account) ?? []) {
      if (m.role !== "kid") continue;
      for (const parent of graph.parents.get(m.familyId) ?? []) observers.add(parent);
    }
  }
  return observers;
}

// The observers of `members` who aren't among them yet (a parent who is a member in their own right isn't an
// observer: they write like anyone else).
export function missingObservers(graph: Families, members: string[]): string[] {
  const present = new Set(members);
  return [...observersOf(graph, members)].filter((parent) => !present.has(parent));
}

// Whether a and b may be in a conversation together: same family, or connected families with every kid among
// them shared through that connection.
export function mayTalk(graph: Families, a: string, b: string): boolean {
  const fa = graph.of.get(a) ?? [];
  const fb = graph.of.get(b) ?? [];
  for (const x of fa) {
    for (const y of fb) {
      if (x.familyId === y.familyId) return true;
      for (const id of graph.connections.get(pairKey(x.familyId, y.familyId)) ?? []) {
        const kids = graph.shared.get(id) ?? new Set<string>();
        const aOk = x.role === "parent" || kids.has(a);
        const bOk = y.role === "parent" || kids.has(b);
        if (aOk && bOk) return true;
      }
    }
  }
  return false;
}

export function allowedTogether(graph: Families, members: string[]): boolean {
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i];
      const b = members[j];
      if (a === undefined || b === undefined || !mayTalk(graph, a, b)) return false;
    }
  }
  return true;
}

// Role of an account for the member list: kid if it is a kid in any family, else parent.
export function roleOf(graph: Families, accountId: string): Role {
  return isKid(graph, accountId) ? "kid" : "parent";
}

export interface Contact {
  accountId: string;
  role: Role;
  familyId: string;
}

// The accounts `accountId` may start a conversation with (api #73, discovery): everyone in its own families, and in
// connected families the parents and the shared kids, under the same rule as mayTalk(). Ids only: names and avatars
// come from the account service. Observers are not a factor here: they follow the kids, they aren't chosen.
export async function contactsOf(env: Env, accountId: string): Promise<Contact[]> {
  const own = await env.DB.prepare("SELECT family_id FROM family_members WHERE account_id = ?1")
    .bind(accountId)
    .all<{ family_id: string }>();
  const ownFamilies = own.results.map((r) => r.family_id);
  if (ownFamilies.length === 0) return [];
  const families = JSON.stringify(ownFamilies);
  const candidates = await env.DB.prepare(
    `SELECT DISTINCT m.account_id FROM family_members m
     WHERE m.family_id IN (SELECT value FROM json_each(?1))
        OR m.family_id IN (SELECT c.family_b FROM connections c WHERE c.family_a IN (SELECT value FROM json_each(?1)))
        OR m.family_id IN (SELECT c.family_a FROM connections c WHERE c.family_b IN (SELECT value FROM json_each(?1)))
     LIMIT 2000`,
  )
    .bind(families)
    .all<{ account_id: string }>();
  const ids = candidates.results.map((r) => r.account_id).filter((a) => a !== accountId);
  const graph = await loadFamilies(env, [accountId, ...ids]);
  const contacts: Contact[] = [];
  for (const other of ids) {
    if (!mayTalk(graph, accountId, other)) continue;
    for (const m of graph.of.get(other) ?? []) contacts.push({ accountId: other, role: m.role, familyId: m.familyId });
  }
  return contacts.sort((a, b) => (a.familyId + a.accountId < b.familyId + b.accountId ? -1 : 1));
}
