// The key directory, part 1: registering a phone (POST /v1/devices), removing one, the prekey count, and the
// account identity. The server stores libsignal public keys and signatures only, checks their types and sizes,
// and never sees a private key. Signatures are verified by libsignal in the apps when they use a bundle.
import { invalid, onlyFields, readJsonBody } from "./body";
import type { Env } from "./env";
import { empty, error, json } from "./http";
import { isAllowlisted } from "./play-integrity";
import { attest } from "./routes";
import { authenticate, type Session } from "./sessions";

export const MAX_DEVICES = 127;
export const DEVICE_INACTIVE_DAYS = 90;
const MAX_KEYS_BODY_BYTES = 512 * 1024;
const MAX_KEY_ID = 16_777_215;
const EC = { type: 0x05, length: 33 };
const KYBER = { type: 0x08, length: 1569 };
const SIGNATURE_LENGTH = 64;

export class InvalidKeys extends Error {}

const unauthorized = () =>
  error(401, "unauthorized", "Sign in first: send Authorization: Bearer <session token>.", {
    "www-authenticate": "Bearer",
  });

function bytesOf(value: string, what: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new InvalidKeys(`${what} is not base64`);
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

function key(value: unknown, kind: typeof EC, what: string): string {
  if (typeof value !== "string" || value.length > 4096) throw invalid(`${what} must be a base64 string.`);
  const bytes = bytesOf(value, what);
  if (bytes.length !== kind.length || bytes[0] !== kind.type)
    throw new InvalidKeys(`${what} has the wrong type or size`);
  return value;
}

function signature(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length > 256) throw invalid(`${what} must be a base64 string.`);
  if (bytesOf(value, what).length !== SIGNATURE_LENGTH) throw new InvalidKeys(`${what} is not 64 bytes`);
  return value;
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${what} is required.`);
  return value as Record<string, unknown>;
}

function keyId(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_KEY_ID) {
    throw invalid(`${what}.keyId must be an integer from 0 to ${MAX_KEY_ID}.`);
  }
  return value;
}

interface SignedKey {
  keyId: number;
  publicKey: string;
  signature: string;
}

function signedKey(value: unknown, kind: typeof EC, what: string): SignedKey {
  const v = object(value, what);
  onlyFields(v, ["keyId", "publicKey", "signature"], what);
  return {
    keyId: keyId(v.keyId, what),
    publicKey: key(v.publicKey, kind, what),
    signature: signature(v.signature, what),
  };
}

function list<T>(value: unknown, what: string, item: (v: unknown, i: number) => T): T[] {
  if (!Array.isArray(value) || value.length > 100) throw invalid(`${what} must be a list of at most 100 keys.`);
  return value.map(item);
}

function unique(ids: number[], what: string): void {
  if (new Set(ids).size !== ids.length) throw new InvalidKeys(`${what} ids repeat`);
}

export interface DeviceKeys {
  registrationId: number;
  identityKey: string;
  signedPreKey: SignedKey;
  pqLastResortPreKey: SignedKey;
  preKeys: { keyId: number; publicKey: string }[];
  pqPreKeys: SignedKey[];
  pushToken: string | null;
}

export function parseDeviceKeys(body: Record<string, unknown>): DeviceKeys {
  onlyFields(
    body,
    ["registrationId", "identityKey", "signedPreKey", "pqLastResortPreKey", "preKeys", "pqPreKeys", "pushToken"],
    "the body",
  );
  const registrationId = body.registrationId;
  if (
    typeof registrationId !== "number" ||
    !Number.isInteger(registrationId) ||
    registrationId < 1 ||
    registrationId > 16383
  ) {
    throw invalid("registrationId must be an integer from 1 to 16383.");
  }
  let pushToken: string | null = null;
  if (body.pushToken !== undefined) {
    if (typeof body.pushToken !== "string" || body.pushToken.length > 4096) throw invalid("pushToken is too long.");
    pushToken = body.pushToken;
  }
  const keys: DeviceKeys = {
    registrationId,
    identityKey: key(body.identityKey, EC, "identityKey"),
    signedPreKey: signedKey(body.signedPreKey, EC, "signedPreKey"),
    pqLastResortPreKey: signedKey(body.pqLastResortPreKey, KYBER, "pqLastResortPreKey"),
    preKeys: list(body.preKeys, "preKeys", (v, i) => {
      const k = object(v, `preKeys[${i}]`);
      onlyFields(k, ["keyId", "publicKey"], `preKeys[${i}]`);
      return { keyId: keyId(k.keyId, `preKeys[${i}]`), publicKey: key(k.publicKey, EC, `preKeys[${i}]`) };
    }),
    pqPreKeys: list(body.pqPreKeys, "pqPreKeys", (v, i) => signedKey(v, KYBER, `pqPreKeys[${i}]`)),
    pushToken,
  };
  unique(
    keys.preKeys.map((k) => k.keyId),
    "preKeys",
  );
  // Kyber prekeys and the last-resort one share libsignal's id space.
  unique([keys.pqLastResortPreKey.keyId, ...keys.pqPreKeys.map((k) => k.keyId)], "pqPreKeys");
  return keys;
}

// Staging policy "allowlist": a request without attestation needs one of the parent's sign-in identities listed.
export async function parentAllowlisted(env: Env, parentId: string): Promise<boolean> {
  const rows = await env.DB.prepare("SELECT provider, subject FROM parent_identities WHERE parent_id = ?")
    .bind(parentId)
    .all<{ provider: string; subject: string }>();
  return rows.results.some((r) => isAllowlisted(env, r.provider, r.subject));
}

const attestationFailed = () =>
  error(403, "attestation_failed", "Use the ZapaKid app from Google Play or the App Store on a genuine device.");

export async function handleRegisterDevice(request: Request, env: Env): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  const { body, bytes } = await readJsonBody(request, MAX_KEYS_BODY_BYTES);
  let keys: DeviceKeys;
  try {
    keys = parseDeviceKeys(body);
  } catch (e) {
    if (e instanceof InvalidKeys) return error(400, "invalid_keys", `Invalid keys: ${e.message}.`);
    throw e;
  }
  const attestation = await attest(request, bytes, env);
  if (attestation instanceof Response) return attestation;
  if (attestation === "allowlist" && !(await parentAllowlisted(env, session.parentId))) {
    console.log(JSON.stringify({ msg: "attestation failed", reason: "no attestation, not allowlisted" }));
    return attestationFailed();
  }

  const already = await answerIfBound(env, session, keys);
  if (already) return already;

  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO account_identities (account_id, identity_key, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  )
    .bind(session.parentId, keys.identityKey, now)
    .run();
  const identity = await env.DB.prepare("SELECT identity_key FROM account_identities WHERE account_id = ?")
    .bind(session.parentId)
    .first<string>("identity_key");
  if (identity !== keys.identityKey) {
    return error(409, "identity_mismatch", "This isn't the account's identity key.");
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const deviceId = await freeDeviceId(env, session.parentId);
    if (deviceId === null) {
      return error(409, "too_many_devices", `This account has ${MAX_DEVICES} devices. Remove one first.`);
    }
    try {
      if (await storeDevice(env, session, deviceId, keys, now)) return json({ deviceId }, 201);
    } catch (e) {
      // Another session of this account took this id at the same moment: pick again.
      if (/UNIQUE|PRIMARY KEY/i.test(String(e))) continue;
      throw e;
    }
    // Not stored: the session was signed out, or a parallel request on it registered first.
    const fresh = await authenticate(request, env);
    if (!fresh) return unauthorized();
    const answer = await answerIfBound(env, fresh, keys);
    if (answer) return answer;
  }
  throw new Error("device registration retry exhausted");
}

// A session that already has a device: the same keys get the same id (the first answer was lost), others 409.
async function answerIfBound(env: Env, session: Session, keys: DeviceKeys): Promise<Response | null> {
  if (session.deviceId === null) return null;
  const existing = await env.DB.prepare("SELECT signed_prekey FROM devices WHERE account_id = ? AND device_id = ?")
    .bind(session.parentId, session.deviceId)
    .first<string>("signed_prekey");
  if (existing === keys.signedPreKey.publicKey) return json({ deviceId: session.deviceId }, 201);
  return error(409, "device_already_registered", "This session already registered a device with other keys.");
}

async function freeDeviceId(env: Env, accountId: string): Promise<number | null> {
  const taken = await env.DB.prepare("SELECT device_id FROM devices WHERE account_id = ?")
    .bind(accountId)
    .all<{ device_id: number }>();
  const used = new Set(taken.results.map((r) => r.device_id));
  for (let id = 1; id <= MAX_DEVICES; id++) if (!used.has(id)) return id;
  return null;
}

// Stores the device, its prekeys and the session binding in one D1 batch (a transaction). Every statement requires
// the session to still exist, be unexpired and be unbound, so a logout or a parallel registration on the same
// session in the meantime stores nothing. Returns whether the device was stored; throws on a device id conflict.
export async function storeDevice(
  env: Env,
  session: Session,
  deviceId: number,
  keys: DeviceKeys,
  now: string,
): Promise<boolean> {
  const [device] = await env.DB.batch(deviceStatements(env, session, deviceId, keys, now));
  return device?.meta.changes === 1;
}

// The statements storing a device, its prekeys and the session binding; each requires the session to exist, be
// unexpired and unbound. The first one inserts the device (its meta.changes says whether it was stored).
export function deviceStatements(
  env: Env,
  session: Session,
  deviceId: number,
  keys: DeviceKeys,
  now: string,
): D1PreparedStatement[] {
  const account = session.parentId;
  const sessionFree = "EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND device_id IS NULL AND expires_at > ?)";
  const free = [session.tokenHash, now] as const;
  return [
    env.DB.prepare(
      `INSERT INTO devices (account_id, device_id, registration_id, signed_prekey_id, signed_prekey,
         signed_prekey_signature, pq_last_resort_id, pq_last_resort_key, pq_last_resort_signature, push_token,
         created_at, last_seen_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${sessionFree}`,
    ).bind(
      account,
      deviceId,
      keys.registrationId,
      keys.signedPreKey.keyId,
      keys.signedPreKey.publicKey,
      keys.signedPreKey.signature,
      keys.pqLastResortPreKey.keyId,
      keys.pqLastResortPreKey.publicKey,
      keys.pqLastResortPreKey.signature,
      keys.pushToken,
      now,
      now,
      ...free,
    ),
    ...keys.preKeys.map((k) =>
      env.DB.prepare(
        `INSERT INTO one_time_prekeys (account_id, device_id, key_id, public_key) SELECT ?, ?, ?, ? WHERE ${sessionFree}`,
      ).bind(account, deviceId, k.keyId, k.publicKey, ...free),
    ),
    ...keys.pqPreKeys.map((k) =>
      env.DB.prepare(
        `INSERT INTO pq_one_time_prekeys (account_id, device_id, key_id, public_key, signature)
           SELECT ?, ?, ?, ?, ? WHERE ${sessionFree}`,
      ).bind(account, deviceId, k.keyId, k.publicKey, k.signature, ...free),
    ),
    env.DB.prepare(
      "UPDATE sessions SET device_id = ? WHERE token_hash = ? AND device_id IS NULL AND expires_at > ?",
    ).bind(deviceId, ...free),
  ];
}

export async function handleRemoveDevice(request: Request, env: Env, rawId: string): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  const deviceId = /^[1-9]\d{0,2}$/.test(rawId) ? Number(rawId) : 0;
  const notFound = () => error(404, "not_found", "No such device on this account.");
  if (deviceId < 1 || deviceId > MAX_DEVICES) return notFound();
  const [removed] = await env.DB.batch([
    env.DB.prepare("DELETE FROM devices WHERE account_id = ? AND device_id = ? RETURNING device_id").bind(
      session.parentId,
      deviceId,
    ),
    // A removed device is signed out (a lost phone must not keep a working session).
    env.DB.prepare("DELETE FROM sessions WHERE parent_id = ? AND device_id = ?").bind(session.parentId, deviceId),
  ]);
  if (!removed?.results.length) return notFound();
  return empty(204);
}

export async function handleCountPreKeys(request: Request, env: Env): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  if (session.deviceId === null) {
    return error(409, "device_not_registered", "Register this device first: POST /v1/devices.");
  }
  const [ec, pq] = await env.DB.batch<{ n: number }>([
    env.DB.prepare("SELECT count(*) AS n FROM one_time_prekeys WHERE account_id = ? AND device_id = ?").bind(
      session.parentId,
      session.deviceId,
    ),
    env.DB.prepare("SELECT count(*) AS n FROM pq_one_time_prekeys WHERE account_id = ? AND device_id = ?").bind(
      session.parentId,
      session.deviceId,
    ),
  ]);
  return json({ preKeys: ec?.results[0]?.n ?? 0, pqPreKeys: pq?.results[0]?.n ?? 0 });
}

export async function handleGetIdentity(request: Request, env: Env, accountId: string): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  const notFound = () => error(404, "not_found", "No identity for this account, or not one you may see.");
  // Only the caller's own account until families and connections exist.
  if (accountId !== session.parentId) return notFound();
  const identityKey = await env.DB.prepare("SELECT identity_key FROM account_identities WHERE account_id = ?")
    .bind(accountId)
    .first<string>("identity_key");
  if (!identityKey) return notFound();
  const changes = await env.DB.prepare(
    `SELECT identity_key AS identityKey, previous_key AS previousIdentityKey, endorsement, changed_at AS changedAt
       FROM identity_key_changes WHERE account_id = ? ORDER BY changed_at, rowid`,
  )
    .bind(accountId)
    .all();
  return json({ identityKey, changes: changes.results });
}
