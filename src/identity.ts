// PUT /v1/keys/identity: replace the account identity key. Never silent: the change goes into the key history
// with the old key's endorsement (libsignal signAlternateIdentity; peers verify it, the server can't). Gated by
// the session, app attestation and a fresh sign-in (under 10 minutes), so a stolen old session can't do it.
// Everything happens in one D1 batch: the identity, the history, removing every device (prekeys cascade) and
// every other session, and storing this phone as the account's only device.
import { readJsonBody } from "./body";
import { deviceStatements, InvalidKeys, parentAllowlisted, parseDeviceKeys } from "./devices";
import type { Env } from "./env";
import { error, json } from "./http";
import { attest } from "./routes";
import { authenticate } from "./sessions";

export const REAUTH_WINDOW_MS = 10 * 60_000;
const MAX_KEYS_BODY_BYTES = 512 * 1024;

const unauthorized = () =>
  error(401, "unauthorized", "Sign in first: send Authorization: Bearer <session token>.", {
    "www-authenticate": "Bearer",
  });

function endorsementOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new InvalidKeys("endorsement is not base64");
  }
  if (atob(value).length !== 64) throw new InvalidKeys("endorsement is not 64 bytes");
  return value;
}

export async function handleChangeIdentity(request: Request, env: Env): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  const { body, bytes } = await readJsonBody(request, MAX_KEYS_BODY_BYTES);
  let keys;
  let endorsement: string | null;
  try {
    const { endorsement: rawEndorsement, ...deviceBody } = body;
    keys = parseDeviceKeys(deviceBody);
    endorsement = endorsementOf(rawEndorsement);
  } catch (e) {
    if (e instanceof InvalidKeys) return error(400, "invalid_keys", `Invalid keys: ${e.message}.`);
    throw e;
  }
  const attestation = await attest(request, bytes, env);
  if (attestation instanceof Response) return attestation;
  if (attestation === "allowlist" && !(await parentAllowlisted(env, session.parentId))) {
    return error(
      403,
      "attestation_failed",
      "Use the ZapaKid app from Google Play or the App Store on a genuine device.",
    );
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const freshSince = new Date(now.getTime() - REAUTH_WINDOW_MS).toISOString();
  const createdAt = await env.DB.prepare("SELECT created_at FROM sessions WHERE token_hash = ?")
    .bind(session.tokenHash)
    .first<string>("created_at");
  if (!createdAt) return unauthorized();
  if (createdAt <= freshSince) {
    return error(403, "reauthentication_required", "Sign in again (within the last 10 minutes), then retry.");
  }
  const current = await env.DB.prepare("SELECT identity_key FROM account_identities WHERE account_id = ?")
    .bind(session.parentId)
    .first<string>("identity_key");
  if (!current) return error(409, "no_identity", "This account has no identity yet: register with POST /v1/devices.");
  if (current === keys.identityKey)
    return error(409, "identity_unchanged", "This is already the account's identity key.");

  const account = session.parentId;
  // Every statement after the first runs only if the first one changed the identity (the account's key is the new
  // one now), so a concurrent change, a logout or an expired session leaves everything as it was.
  const changed = "(SELECT identity_key FROM account_identities WHERE account_id = ?) = ?";
  const ifChanged = [account, keys.identityKey] as const;
  const [update] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE account_identities SET identity_key = ? WHERE account_id = ? AND identity_key = ?
         AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ? AND created_at > ?)`,
    ).bind(keys.identityKey, account, current, session.tokenHash, nowIso, freshSince),
    env.DB.prepare(
      `INSERT INTO identity_key_changes (account_id, previous_key, identity_key, endorsement, changed_at)
         SELECT ?, ?, ?, ?, ? WHERE ${changed}`,
    ).bind(account, current, keys.identityKey, endorsement, nowIso, ...ifChanged),
    env.DB.prepare(`DELETE FROM devices WHERE account_id = ? AND ${changed}`).bind(account, ...ifChanged),
    env.DB.prepare(`DELETE FROM sessions WHERE parent_id = ? AND token_hash != ? AND ${changed}`).bind(
      account,
      session.tokenHash,
      ...ifChanged,
    ),
    env.DB.prepare(`UPDATE sessions SET device_id = NULL WHERE token_hash = ? AND ${changed}`).bind(
      session.tokenHash,
      ...ifChanged,
    ),
    ...deviceStatements(env, session, 1, keys, nowIso),
  ]);
  if (update?.meta.changes !== 1) {
    return error(409, "identity_changed_concurrently", "The identity changed meanwhile or you were signed out; retry.");
  }
  console.log(JSON.stringify({ msg: "identity changed", endorsed: endorsement !== null }));
  return json({ deviceId: 1 });
}
