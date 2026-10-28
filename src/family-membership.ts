// Membership, as the chat token issuer and the chat and calls services need it. A scope is a set of accounts that
// may be put in conversations together: "family:<familyId>" today (its parents and kids), "connection:<id>" when
// families connect (api #44). The chat service owns the conversations themselves and who is in each one; a scope is
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

// Every scope the account belongs to.
export async function conversationScopes(env: Env, accountId: string): Promise<string[]> {
  const account = await accountOf(env, accountId);
  return account ? [familyScope(account.familyId)] : [];
}

// Everyone in a scope; [] for an unknown or malformed scope.
export async function membersOf(env: Env, scope: string): Promise<Member[]> {
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
