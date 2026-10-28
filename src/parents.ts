// Parents and their Apple/Google identities. Accounts are found by (provider, subject) only, never by email.
import type { AgeRange } from "./age";
import type { Env } from "./env";
import type { Identity } from "./providers";
import { hashToken, newToken, ttlSeconds } from "./sessions";

// D1 column age_category: "adult", or "unknown" = the platform's age API was unavailable (API: "unavailable").
interface ParentRow {
  id: string;
  email: string | null;
  display_name: string | null;
  age_category: "adult" | "unknown";
  age_source: AgeRange["source"];
  age_lower: number | null;
  age_upper: number | null;
  age_platform_status: string | null;
  age_checked_at: string;
  created_at: string;
}

export interface Parent {
  id: string;
  email: string | null;
  displayName: string | null;
  ageRange: {
    category: "adult" | "unavailable";
    source: AgeRange["source"];
    lowerBound: number | null;
    upperBound: number | null;
    platformStatus: string | null;
    checkedAt: string;
  };
  createdAt: string;
}

function toParent(row: ParentRow): Parent {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    ageRange: {
      category: row.age_category === "adult" ? "adult" : "unavailable",
      source: row.age_source,
      lowerBound: row.age_lower,
      upperBound: row.age_upper,
      platformStatus: row.age_platform_status,
      checkedAt: row.age_checked_at,
    },
    createdAt: row.created_at,
  };
}

export async function getParent(env: Env, id: string): Promise<Parent | null> {
  const row = await env.DB.prepare("SELECT * FROM parents WHERE id = ?").bind(id).first<ParentRow>();
  return row ? toParent(row) : null;
}

export async function setDisplayName(env: Env, id: string, displayName: string): Promise<void> {
  await env.DB.prepare("UPDATE parents SET display_name = ?, updated_at = ? WHERE id = ?")
    .bind(displayName, new Date().toISOString(), id)
    .run();
}

// A parent keeps at most this many sessions; a new sign-in signs out the oldest beyond it.
export const MAX_SESSIONS_PER_PARENT = 20;

export interface SignInResult {
  session: { token: string; expiresAt: string };
  parent: Parent;
  newAccount: boolean;
}

// Finds or creates the parent for this identity, records the age range and starts a session, in one D1 batch
// (a transaction). The caller has already rejected minors and declined age ranges.
export async function signIn(
  env: Env,
  identity: Identity,
  age: AgeRange,
  category: "adult" | "unavailable",
  displayName: string | null,
): Promise<SignInResult> {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds(env) * 1000).toISOString();
  const token = newToken();
  const tokenHash = await hashToken(token);
  const db = env.DB;

  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await db
      .prepare("SELECT parent_id FROM parent_identities WHERE provider = ? AND subject = ?")
      .bind(identity.provider, identity.subject)
      .first<{ parent_id: string }>();
    const parentId = existing?.parent_id ?? crypto.randomUUID();
    const dbCategory = category === "adult" ? "adult" : "unknown";
    const ageValues = [dbCategory, age.source, age.lowerBound, age.upperBound, age.platformStatus, nowIso] as const;
    const statements = existing
      ? [
          db
            .prepare(
              `UPDATE parents SET age_category = ?, age_source = ?, age_lower = ?, age_upper = ?,
                 age_platform_status = ?, age_checked_at = ?, email = coalesce(?, email), updated_at = ?
               WHERE id = ?`,
            )
            .bind(...ageValues, identity.email, nowIso, parentId),
          db
            .prepare("UPDATE parent_identities SET last_sign_in_at = ? WHERE provider = ? AND subject = ?")
            .bind(nowIso, identity.provider, identity.subject),
        ]
      : [
          db
            .prepare(
              `INSERT INTO parents (age_category, age_source, age_lower, age_upper, age_platform_status,
                 age_checked_at, email, display_name, id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(...ageValues, identity.email, displayName ?? identity.name, parentId, nowIso, nowIso),
          db
            .prepare(
              `INSERT INTO parent_identities (provider, subject, parent_id, created_at, last_sign_in_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .bind(identity.provider, identity.subject, parentId, nowIso, nowIso),
        ];
    statements.push(
      db
        .prepare("INSERT INTO sessions (token_hash, parent_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind(tokenHash, parentId, nowIso, expiresAt),
      db
        .prepare(
          `DELETE FROM sessions WHERE parent_id = ? AND token_hash NOT IN
             (SELECT token_hash FROM sessions WHERE parent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
        )
        .bind(parentId, parentId, MAX_SESSIONS_PER_PARENT),
    );
    try {
      await db.batch(statements);
    } catch (e) {
      // Two first sign-ins at once: the other one created the identity. Retry once as an existing parent.
      if (!existing && attempt === 0 && /UNIQUE|PRIMARY KEY/i.test(String(e))) continue;
      throw e;
    }
    const parent = await getParent(env, parentId);
    if (!parent) throw new Error("parent vanished after sign-in");
    return { session: { token, expiresAt }, parent, newAccount: !existing };
  }
  throw new Error("sign-in retry exhausted");
}
