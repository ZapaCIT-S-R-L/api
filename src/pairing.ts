// Kid pairing by QR. A parent creates a one-time code for one of the family's kids (a new kid: add it first, then
// pair; an existing kid: a new or replaced phone). The kid's phone scans the QR and redeems the code for a kid
// session. Kids never sign in with Apple or Google. Codes: 256 random bits, 5 minutes, single use, SHA-256 only.
import { invalid, onlyFields, readJson, readJsonBody } from "./body";
import { randomBase64Url, sha256Hex } from "./crypto";
import type { Env } from "./env";
import { loadKid, type Kid } from "./families";
import { error, json } from "./http";
import { isAllowlisted } from "./play-integrity";
import { attest } from "./routes";
import { authenticate, hashToken } from "./sessions";

export const PAIRING_TTL_SECONDS = 5 * 60;
export const MAX_OPEN_PAIRINGS = 5;
// A kid can't sign in again on their own; pairing again gives a new session. 30 days until kid unpair/logout
// exists: today deleting the kid is the only way to revoke a lost kid phone.
export const KID_SESSION_TTL_SECONDS = 30 * 86_400;
const PAIRING_PATTERN = /^zkp_[A-Za-z0-9_-]{43}$/;

const unauthorized = () =>
  error(401, "unauthorized", "Sign in first: send Authorization: Bearer <session token>.", {
    "www-authenticate": "Bearer",
  });

export async function handleCreatePairing(
  request: Request,
  env: Env,
  familyId: string,
  kidId: string,
): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  // The kid must belong to a family the caller is a parent of.
  const member = await env.DB.prepare(
    `SELECT 1 AS ok FROM kids k JOIN family_parents fp ON fp.family_id = k.family_id
     WHERE k.id = ? AND k.family_id = ? AND fp.parent_id = ?`,
  )
    .bind(kidId, familyId, session.parentId)
    .first<{ ok: number }>();
  if (!member) return error(404, "not_found", "No such kid.");
  // No body is fine, and so is an empty one: the iOS app sends Content-Length: 0 without a Content-Type.
  if (request.body && request.headers.get("content-length") !== "0")
    onlyFields(await readJson(request), [], "the body");

  const now = new Date();
  const nowIso = now.toISOString();
  const open = await env.DB.prepare(
    "SELECT count(*) AS n FROM kid_pairings WHERE family_id = ? AND used_at IS NULL AND expires_at > ?",
  )
    .bind(familyId, nowIso)
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_PAIRINGS) {
    return error(429, "too_many_pairings", `At most ${MAX_OPEN_PAIRINGS} open pairing codes per family.`, {
      "retry-after": String(PAIRING_TTL_SECONDS),
    });
  }

  const code = `zkp_${randomBase64Url(32)}`;
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO kid_pairings (code_hash, kid_id, family_id, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(await sha256Hex(code), kidId, familyId, session.parentId, nowIso, expiresAt)
    .run();
  const kid = await loadKid(env, kidId);
  return json({ code, expiresAt, kid }, 201);
}

const gone = () => error(410, "pairing_code_invalid", "This pairing code is unknown, expired or already used.");

export async function handleRedeemPairing(request: Request, env: Env): Promise<Response> {
  const { body, bytes } = await readJsonBody(request);
  onlyFields(body, ["code"], "the body");
  if (typeof body.code !== "string" || !PAIRING_PATTERN.test(body.code)) {
    throw invalid("code is required: the pairing code from the parent's QR (zkp_...).");
  }
  const codeHash = await sha256Hex(body.code);
  const attestation = await attest(request, bytes, env);
  if (attestation instanceof Response) return attestation;

  const nowIso = new Date().toISOString();
  const pairing = await env.DB.prepare(
    "SELECT kid_id, family_id, created_by FROM kid_pairings WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
  )
    .bind(codeHash, nowIso)
    .first<{ kid_id: string; family_id: string; created_by: string }>();
  if (!pairing) return gone();

  // Staging ("allowlist"): without attestation only codes made by an allowlisted test parent work.
  if (attestation === "allowlist" && !(await parentAllowlisted(env, pairing.created_by))) {
    console.log(JSON.stringify({ msg: "attestation failed", reason: "no attestation, parent not allowlisted" }));
    return error(
      403,
      "attestation_failed",
      "Use the ZapaKid app from Google Play or the App Store on a genuine device.",
    );
  }

  const token = `zkk_${randomBase64Url(32)}`;
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + KID_SESSION_TTL_SECONDS * 1000).toISOString();
  // One transaction: use up the code (only if still open), then create the session only for this redemption.
  const [claim] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE kid_pairings SET used_at = ?, session_hash = ?
       WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
    ).bind(nowIso, tokenHash, codeHash, nowIso),
    env.DB.prepare(
      `INSERT INTO kid_sessions (token_hash, kid_id, created_at, expires_at)
       SELECT ?, kid_id, ?, ? FROM kid_pairings WHERE code_hash = ? AND session_hash = ?`,
    ).bind(tokenHash, nowIso, expiresAt, codeHash, tokenHash),
  ]);
  if ((claim?.meta.changes ?? 0) !== 1) return gone();

  const kid: Kid | null = await loadKid(env, pairing.kid_id);
  const family = await env.DB.prepare("SELECT id, name FROM families WHERE id = ?")
    .bind(pairing.family_id)
    .first<{ id: string; name: string | null }>();
  if (!kid || !family) return gone();
  return json({ session: { token, expiresAt }, kid, family: { id: family.id, name: family.name } });
}

async function parentAllowlisted(env: Env, parentId: string): Promise<boolean> {
  const { results } = await env.DB.prepare("SELECT provider, subject FROM parent_identities WHERE parent_id = ?")
    .bind(parentId)
    .all<{ provider: string; subject: string }>();
  return results.some((r) => isAllowlisted(env, r.provider, r.subject));
}
