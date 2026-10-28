// The family rules, on the chat service's copy of the family graph (D1, fed by membership events):
//   - every conversation with a kid includes the current parents of the kid's family (guardians);
//   - two members from different families need a connection between their families, and a kid needs to be shared
//     through it;
//   - only parents start conversations.
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
}

const pairKey = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);

// The graph around the given accounts: their families, those families' parents, and the connections between them.
export async function loadFamilies(env: Env, accountIds: string[]): Promise<Families> {
  const of = new Map<string, { familyId: string; role: Role }[]>();
  const parents = new Map<string, string[]>();
  const connections = new Map<string, string[]>();
  const shared = new Map<string, Set<string>>();
  if (accountIds.length === 0) return { of, connections, shared, parents };

  const ids = JSON.stringify([...new Set(accountIds)]);
  const memberships = await env.DB.prepare(
    `SELECT family_id, account_id, role FROM family_members
     WHERE family_id IN (SELECT family_id FROM family_members WHERE account_id IN (SELECT value FROM json_each(?1)))`,
  )
    .bind(ids)
    .all<{ family_id: string; account_id: string; role: Role }>();
  const familyIds = new Set<string>();
  for (const row of memberships.results) {
    familyIds.add(row.family_id);
    const list = of.get(row.account_id) ?? [];
    list.push({ familyId: row.family_id, role: row.role });
    of.set(row.account_id, list);
    if (row.role === "parent") parents.set(row.family_id, [...(parents.get(row.family_id) ?? []), row.account_id]);
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
  return { of, connections, shared, parents };
}

export function isParent(graph: Families, accountId: string): boolean {
  return (graph.of.get(accountId) ?? []).some((m) => m.role === "parent");
}

export function isKid(graph: Families, accountId: string): boolean {
  return (graph.of.get(accountId) ?? []).some((m) => m.role === "kid");
}

// The parents of every kid's family among `members`, who aren't members yet.
export function missingGuardians(graph: Families, members: string[]): string[] {
  const present = new Set(members);
  const missing = new Set<string>();
  for (const account of members) {
    for (const m of graph.of.get(account) ?? []) {
      if (m.role !== "kid") continue;
      for (const parent of graph.parents.get(m.familyId) ?? []) if (!present.has(parent)) missing.add(parent);
    }
  }
  return [...missing];
}

// Whether a and b may be in a conversation together: same family, or connected families with every kid among
// them shared through that connection.
function mayTalk(graph: Families, a: string, b: string): boolean {
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
