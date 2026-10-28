// Who is calling: a parent (zks_ session from Apple/Google sign-in) or a kid (zkk_ session from QR pairing). Both
// tokens are random and stored as SHA-256 only. Endpoints that only parents may use keep calling authenticate()
// (sessions.ts), which never accepts a kid token.
import type { Env } from "./env";
import { hashToken, authenticate } from "./sessions";

const KID_TOKEN_PATTERN = /^zkk_[A-Za-z0-9_-]{43}$/;

export type Account =
  { role: "parent"; id: string; tokenHash: string } | { role: "kid"; id: string; familyId: string; tokenHash: string };

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
    `SELECT s.kid_id, s.expires_at, k.family_id FROM kid_sessions s JOIN kids k ON k.id = s.kid_id
     WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{ kid_id: string; expires_at: string; family_id: string }>();
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    await env.DB.prepare("DELETE FROM kid_sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }
  return { role: "kid", id: row.kid_id, familyId: row.family_id, tokenHash };
}

// A parent or a kid, or null.
export async function authenticateAccount(request: Request, env: Env): Promise<Account | null> {
  const kid = await authenticateKid(request, env);
  if (kid) return kid;
  const parent = await authenticate(request, env);
  return parent ? { role: "parent", id: parent.parentId, tokenHash: parent.tokenHash } : null;
}
