// Membership, as the chat token issuer and the chat and calls services need it. A scope is a set of accounts that
// may be put in conversations together: "family:<familyId>" (its parents and kids) and "connection:<id>" (both
// families' parents and the kids shared in the connection). The chat service owns the conversations themselves and who is in each one; a scope is
// the upper bound. Accounts are parents and kids; their ids are UUIDs and never collide.
//
// conversationScopes() has the shape of MembershipSource.conversations (src/membership.ts on the chat-token branch),
// so the token issuer can use it directly.
import type { Env } from "./env";

export type Role = "parent" | "kid";

export interface Member {
  accountId: string;
  role: Role;
}

const FAMILY_SCOPE = /^family:([0-9a-f-]{36})$/;
const CONNECTION_SCOPE = /^connection:([0-9a-f-]{36})$/;

export function familyScope(familyId: string): string {
  return `family:${familyId}`;
}

// The account's role and family, or null for an unknown account.
export async function accountOf(env: Env, accountId: string): Promise<{ role: Role; familyId: string } | null> {
  const row = await env.DB.prepare(
    `SELECT 'parent' AS role, family_id FROM family_parents WHERE parent_id = ?1
     UNION ALL SELECT 'kid' AS role, family_id FROM kids WHERE id = ?1 LIMIT 1`,
  )
    .bind(accountId)
    .first<{ role: Role; family_id: string }>();
  return row ? { role: row.role, familyId: row.family_id } : null;
}

// Every scope the account belongs to: its family, then the connections it is in (a parent: every connection of the
// family; a kid: the connections it is shared in).
export async function conversationScopes(env: Env, accountId: string): Promise<string[]> {
  const account = await accountOf(env, accountId);
  if (!account) return [];
  const { results } =
    account.role === "parent"
      ? await env.DB.prepare(
          "SELECT id FROM family_connections WHERE family_a = ?1 OR family_b = ?1 ORDER BY created_at, id",
        )
          .bind(account.familyId)
          .all<{ id: string }>()
      : await env.DB.prepare(
          `SELECT c.id FROM connection_shared_kids s JOIN family_connections c ON c.id = s.connection_id
           WHERE s.kid_id = ? ORDER BY c.created_at, c.id`,
        )
          .bind(accountId)
          .all<{ id: string }>();
  return [familyScope(account.familyId), ...results.map((r) => `connection:${r.id}`)];
}

// Everyone in a scope; [] for an unknown or malformed scope. A connection: both families' parents and the kids
// shared in it.
export async function membersOf(env: Env, scope: string): Promise<Member[]> {
  const connectionId = CONNECTION_SCOPE.exec(scope)?.[1];
  if (connectionId) {
    const { results } = await env.DB.prepare(
      `SELECT fp.parent_id AS account_id, 'parent' AS role FROM family_connections c
         JOIN family_parents fp ON fp.family_id IN (c.family_a, c.family_b) WHERE c.id = ?1
       UNION ALL SELECT kid_id AS account_id, 'kid' AS role FROM connection_shared_kids WHERE connection_id = ?1`,
    )
      .bind(connectionId)
      .all<{ account_id: string; role: Role }>();
    return results.map((r) => ({ accountId: r.account_id, role: r.role }));
  }
  const familyId = FAMILY_SCOPE.exec(scope)?.[1];
  if (!familyId) return [];
  const { results } = await env.DB.prepare(
    `SELECT parent_id AS account_id, 'parent' AS role FROM family_parents WHERE family_id = ?1
     UNION ALL SELECT id AS account_id, 'kid' AS role FROM kids WHERE family_id = ?1`,
  )
    .bind(familyId)
    .all<{ account_id: string; role: Role }>();
  return results.map((r) => ({ accountId: r.account_id, role: r.role }));
}
