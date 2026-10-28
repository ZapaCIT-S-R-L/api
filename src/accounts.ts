// Who is calling: a parent (zks_ session from Apple/Google sign-in) or a kid (zkk_ session from QR pairing). Both
// tokens are random and stored as SHA-256 only. Endpoints that only parents may use keep calling authenticate()
// (sessions.ts), which never accepts a kid token. Devices and keys work for both: a session of either kind is bound
// to the device registered on it (sessions.device_id, kid_sessions.device_id).
import type { Env } from "./env";
import { isAllowlisted } from "./play-integrity";
import { hashToken, authenticate, touchDevice } from "./sessions";

const KID_TOKEN_PATTERN = /^zkk_[A-Za-z0-9_-]{43}$/;
const DAY_MS = 86_400_000;

export type Account = (
  { role: "parent"; id: string; tokenHash: string } | { role: "kid"; id: string; familyId: string; tokenHash: string }
) & {
  // The device registered on this session (POST /v1/devices), or null.
  deviceId: number | null;
};

// The session table of the account's kind and its owner column. Constants only: safe to put into SQL.
export function sessionTable(account: Pick<Account, "role">): {
  table: "sessions" | "kid_sessions";
  owner: "parent_id" | "kid_id";
} {
  return account.role === "kid"
    ? { table: "kid_sessions", owner: "kid_id" }
    : { table: "sessions", owner: "parent_id" };
}

function kidBearer(request: Request): string | null {
  const token = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  return token && KID_TOKEN_PATTERN.test(token) ? token : null;
}

// The live kid session for this request, or null. Expired sessions are deleted when seen.
export async function authenticateKid(request: Request, env: Env): Promise<Extract<Account, { role: "kid" }> | null> {
  const token = kidBearer(request);
  if (!token) return null;
  const tokenHash = await hashToken(token);
  const row = await env.DB.prepare(
    `SELECT s.kid_id, s.expires_at, s.device_id, k.family_id FROM kid_sessions s JOIN kids k ON k.id = s.kid_id
     WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{ kid_id: string; expires_at: string; device_id: number | null; family_id: string }>();
  if (!row) return null;
  const now = Date.now();
  if (Date.parse(row.expires_at) <= now) {
    await env.DB.prepare("DELETE FROM kid_sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }
  // Day-granular activity (written on the first request of a day), so a parent can tell a lost phone from the one
  // in use (GET /v1/families/{familyId}/kids/{kidId}/sessions, api #78).
  await env.DB.prepare(
    "UPDATE kid_sessions SET last_seen_at = ? WHERE token_hash = ? AND coalesce(last_seen_at, created_at) < ?",
  )
    .bind(new Date(now).toISOString(), tokenHash, new Date(now - DAY_MS).toISOString())
    .run();
  await touchDevice(env, row.kid_id, row.device_id);
  return { role: "kid", id: row.kid_id, familyId: row.family_id, tokenHash, deviceId: row.device_id };
}

// A parent or a kid, or null.
export async function authenticateAccount(request: Request, env: Env): Promise<Account | null> {
  const kid = await authenticateKid(request, env);
  if (kid) return kid;
  const parent = await authenticate(request, env);
  return parent
    ? { role: "parent", id: parent.parentId, tokenHash: parent.tokenHash, deviceId: parent.deviceId }
    : null;
}

// Staging policy "allowlist": a request without attestation needs an allowlisted sign-in identity. ATTESTATION_ALLOWLIST
// lists parents' identities (provider:subject); a kid has none, so a kid counts when a parent of its family is listed.
export async function accountAllowlisted(env: Env, account: Account): Promise<boolean> {
  const { results } = await (
    account.role === "kid"
      ? env.DB.prepare(
          `SELECT i.provider, i.subject FROM family_parents fp JOIN parent_identities i ON i.parent_id = fp.parent_id
           WHERE fp.family_id = ?`,
        ).bind(account.familyId)
      : env.DB.prepare("SELECT provider, subject FROM parent_identities WHERE parent_id = ?").bind(account.id)
  ).all<{ provider: string; subject: string }>();
  return results.some((r) => isAllowlisted(env, r.provider, r.subject));
}
