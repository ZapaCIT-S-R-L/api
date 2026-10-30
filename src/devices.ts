// The key directory, part 1: registering a phone (POST /v1/devices), removing one, the prekey count, and the
// account identity. The server stores libsignal public keys and signatures only, checks their types and sizes,
// and never sees a private key. Signatures are verified by libsignal in the apps when they use a bundle.
//
// Accounts are parents and kids (accounts.ts): a paired kid's phone registers and fetches keys like a parent's.
import { accountAllowlisted, authenticateAccount, sessionTable, type Account } from "./accounts";
import { invalid, onlyFields, readJsonBody } from "./body";
import type { Env } from "./env";
import { conversationScopes } from "./family-membership";
import { empty, error, json } from "./http";
import { deviceRemovedEvents, flushMembershipEvents, membershipEvent } from "./membership-events";
import { attest } from "./routes";

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

const attestationFailed = () =>
  error(403, "attestation_failed", "Use the ZapaKid app from Google Play or the App Store on a genuine device.");

export async function handleRegisterDevice(request: Request, env: Env): Promise<Response> {
  const session = await authenticateAccount(request, env);
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
  if (attestation === "allowlist" && !(await accountAllowlisted(env, session))) {
    console.log(JSON.stringify({ msg: "attestation failed", reason: "no attestation, not allowlisted" }));
    return attestationFailed();
  }

  const already = await answerIfBound(env, session, keys);
  if (already) return already;

  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO account_identities (account_id, identity_key, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  )
    .bind(session.id, keys.identityKey, now)
    .run();
  const identity = await env.DB.prepare("SELECT identity_key FROM account_identities WHERE account_id = ?")
    .bind(session.id)
    .first<string>("identity_key");
  if (identity !== keys.identityKey) {
    return error(409, "identity_mismatch", "This isn't the account's identity key.");
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const deviceId = await freeDeviceId(env, session.id);
    if (deviceId === null) {
      return error(409, "too_many_devices", `This account has ${MAX_DEVICES} devices. Remove one first.`);
    }
    try {
      if (await storeDevice(env, session, deviceId, keys, now)) {
        await flushMembershipEvents(env);
        return json({ deviceId }, 201);
      }
    } catch (e) {
      // Another session of this account took this id at the same moment: pick again.
      if (/UNIQUE|PRIMARY KEY/i.test(String(e))) continue;
      throw e;
    }
    // Not stored: the session was signed out, or a parallel request on it registered first.
    const fresh = await authenticateAccount(request, env);
    if (!fresh) return unauthorized();
    const answer = await answerIfBound(env, fresh, keys);
    if (answer) return answer;
  }
  throw new Error("device registration retry exhausted");
}

// A session that already has a device: the same keys get the same id (the first answer was lost), others 409.
async function answerIfBound(env: Env, session: Account, keys: DeviceKeys): Promise<Response | null> {
  if (session.deviceId === null) return null;
  const existing = await env.DB.prepare("SELECT signed_prekey FROM devices WHERE account_id = ? AND device_id = ?")
    .bind(session.id, session.deviceId)
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
  session: DeviceOwner,
  deviceId: number,
  keys: DeviceKeys,
  now: string,
): Promise<boolean> {
  const [device] = await env.DB.batch(deviceStatements(env, session, deviceId, keys, now));
  return device?.meta.changes === 1;
}

// The account and session a device is stored for.
export type DeviceOwner = Pick<Account, "role" | "id" | "tokenHash">;

// The statements storing a device, its prekeys, the session binding and its device.upserted event; each requires
// the session to exist, be unexpired and unbound (the event: to be bound to this device by this batch). The first
// one inserts the device (its meta.changes says whether it was stored).
export function deviceStatements(
  env: Env,
  session: DeviceOwner,
  deviceId: number,
  keys: DeviceKeys,
  now: string,
): D1PreparedStatement[] {
  const account = session.id;
  const { table } = sessionTable(session);
  const sessionFree = `EXISTS (SELECT 1 FROM ${table} WHERE token_hash = ? AND device_id IS NULL AND expires_at > ?)`;
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
      `UPDATE ${table} SET device_id = ? WHERE token_hash = ? AND device_id IS NULL AND expires_at > ?`,
    ).bind(deviceId, ...free),
    membershipEvent(
      env,
      {
        type: "device.upserted",
        accountId: account,
        deviceId,
        registrationId: keys.registrationId,
        // A new registration has no push targets until the phone sends them again.
        push: null,
        alertPush: null,
      },
      {
        sql: `EXISTS (SELECT 1 FROM devices WHERE account_id = ? AND device_id = ? AND created_at = ?)
          AND EXISTS (SELECT 1 FROM ${table} WHERE token_hash = ? AND device_id = ?)`,
        binds: [account, deviceId, now, session.tokenHash, deviceId],
      },
    ),
  ];
}

export async function handleRemoveDevice(request: Request, env: Env, rawId: string): Promise<Response> {
  const session = await authenticateAccount(request, env);
  if (!session) return unauthorized();
  const deviceId = parseDeviceId(rawId);
  const notFound = () => error(404, "not_found", "No such device on this account.");
  if (deviceId === null) return notFound();
  const { table, owner } = sessionTable(session);
  const [, removed] = await env.DB.batch([
    deviceRemovedEvents(env, "account_id = ? AND device_id = ?", [session.id, deviceId]),
    env.DB.prepare("DELETE FROM devices WHERE account_id = ? AND device_id = ? RETURNING device_id").bind(
      session.id,
      deviceId,
    ),
    // A removed device is signed out (a lost phone must not keep a working session).
    env.DB.prepare(`DELETE FROM ${table} WHERE ${owner} = ? AND device_id = ?`).bind(session.id, deviceId),
  ]);
  if (!removed?.results.length) return notFound();
  await flushMembershipEvents(env);
  return empty(204);
}

// PUT /v1/devices/{id}/push (the PushKit VoIP token for iPhones, FCM for Android) and PUT /v1/devices/{id}/alert-push
// (the standard APNs token for the visible "new message" alert, iPhones only): where this phone's content-free pushes
// go. A session may only set its own device. `null` for both clears that target. The device.upserted event carries the
// slot it changed; `push` and `alertPush` absent means the slot is not in the event (chat keeps it), `null` clears it.
const PUSH_PROVIDERS = ["apns", "fcm"];
const MAX_PUSH_TOKEN_LENGTH = 4096;

type PushTarget = { provider: "apns" | "fcm"; token: string };

function pushTarget(body: Record<string, unknown>, providers: string[]): PushTarget | null {
  if (body.provider === null && body.token === null) return null;
  if (typeof body.provider !== "string" || !providers.includes(body.provider)) {
    throw invalid(`provider must be ${providers.join(" or ")} (both null to clear).`);
  }
  if (typeof body.token !== "string" || body.token.length === 0 || body.token.length > MAX_PUSH_TOKEN_LENGTH) {
    throw invalid(`token must be 1 to ${MAX_PUSH_TOKEN_LENGTH} characters.`);
  }
  return { provider: body.provider as "apns" | "fcm", token: body.token };
}

async function setPushTarget(request: Request, env: Env, rawId: string, slot: "voip" | "alert"): Promise<Response> {
  const session = await authenticateAccount(request, env);
  if (!session) return unauthorized();
  if (session.deviceId === null) {
    return error(409, "device_not_registered", "Register this device first: POST /v1/devices.");
  }
  const deviceId = parseDeviceId(rawId);
  if (deviceId !== session.deviceId) return error(404, "not_found", "No such device on this account.");
  const { body } = await readJsonBody(request);
  onlyFields(body, ["provider", "token"], "the push target");
  const target = pushTarget(body, slot === "alert" ? ["apns"] : PUSH_PROVIDERS);
  const row = await env.DB.prepare(
    "SELECT registration_id, push_provider, push_token, alert_push_token FROM devices WHERE account_id = ? AND device_id = ?",
  )
    .bind(session.id, deviceId)
    .first<{
      registration_id: number;
      push_provider: string | null;
      push_token: string | null;
      alert_push_token: string | null;
    }>();
  if (!row) return error(404, "not_found", "No such device on this account.");
  // An update authenticated before logout must not restore a target after logout has cleared it.
  const { table, owner } = sessionTable(session);
  const liveSession = `EXISTS (SELECT 1 FROM ${table} WHERE token_hash = ? AND ${owner} = ?
    AND device_id = ? AND expires_at > ?)`;
  const liveBinds = [session.tokenHash, session.id, deviceId, new Date().toISOString()];
  let updated: D1Result | undefined;
  // The event is written only when the update happened (the same batch, so the row is still the one we wrote).
  if (slot === "voip") {
    const provider = target?.provider ?? null;
    const token = target?.token ?? null;
    [updated] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE devices SET push_provider = ?, push_token = ? WHERE account_id = ? AND device_id = ? AND ${liveSession}`,
      ).bind(provider, token, session.id, deviceId, ...liveBinds),
      membershipEvent(
        env,
        { type: "device.upserted", accountId: session.id, deviceId, registrationId: row.registration_id, push: target },
        {
          sql: `EXISTS (SELECT 1 FROM devices WHERE account_id = ? AND device_id = ? AND push_provider IS ? AND push_token IS ?) AND ${liveSession}`,
          binds: [session.id, deviceId, provider, token, ...liveBinds],
        },
      ),
    ]);
  } else {
    // Validated above: the alert slot takes APNs only.
    const alertTarget = target?.provider === "apns" ? { provider: "apns" as const, token: target.token } : null;
    const token = alertTarget?.token ?? null;
    [updated] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE devices SET alert_push_token = ? WHERE account_id = ? AND device_id = ? AND ${liveSession}`,
      ).bind(token, session.id, deviceId, ...liveBinds),
      membershipEvent(
        env,
        {
          type: "device.upserted",
          accountId: session.id,
          deviceId,
          registrationId: row.registration_id,
          alertPush: alertTarget,
        },
        {
          sql: `EXISTS (SELECT 1 FROM devices WHERE account_id = ? AND device_id = ? AND alert_push_token IS ?) AND ${liveSession}`,
          binds: [session.id, deviceId, token, ...liveBinds],
        },
      ),
    ]);
  }
  if (!updated?.meta.changes) return unauthorized();
  await flushMembershipEvents(env);
  return empty(204);
}

export function handleSetDevicePush(request: Request, env: Env, rawId: string): Promise<Response> {
  return setPushTarget(request, env, rawId, "voip");
}

export function handleSetDevicePushAlert(request: Request, env: Env, rawId: string): Promise<Response> {
  return setPushTarget(request, env, rawId, "alert");
}

function parseDeviceId(raw: string): number | null {
  const id = /^[1-9]\d{0,2}$/.test(raw) ? Number(raw) : 0;
  return id >= 1 && id <= MAX_DEVICES ? id : null;
}

export async function handleCountPreKeys(request: Request, env: Env): Promise<Response> {
  const session = await authenticateAccount(request, env);
  if (!session) return unauthorized();
  if (session.deviceId === null) {
    return error(409, "device_not_registered", "Register this device first: POST /v1/devices.");
  }
  const [ec, pq] = await env.DB.batch<{ n: number }>([
    env.DB.prepare("SELECT count(*) AS n FROM one_time_prekeys WHERE account_id = ? AND device_id = ?").bind(
      session.id,
      session.deviceId,
    ),
    env.DB.prepare("SELECT count(*) AS n FROM pq_one_time_prekeys WHERE account_id = ? AND device_id = ?").bind(
      session.id,
      session.deviceId,
    ),
  ]);
  return json({ preKeys: ec?.results[0]?.n ?? 0, pqPreKeys: pq?.results[0]?.n ?? 0 });
}

export async function handleGetIdentity(request: Request, env: Env, accountId: string): Promise<Response> {
  const session = await authenticateAccount(request, env);
  if (!session) return unauthorized();
  const notFound = () => error(404, "not_found", "No identity for this account, or not one you may see.");
  if (!(await mayTalk(env, session.id, accountId))) return notFound();
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

// Whether two accounts may talk: the same account (its other devices), or both in one scope (a family, or a
// connection: both families' parents and the kids shared in it). family-membership.ts defines the scopes.
export async function mayTalk(env: Env, caller: string, accountId: string): Promise<boolean> {
  if (caller === accountId) return true;
  const [mine, theirs] = await Promise.all([conversationScopes(env, caller), conversationScopes(env, accountId)]);
  return mine.some((scope) => theirs.includes(scope));
}

interface DeviceRow {
  device_id: number;
  registration_id: number;
  signed_prekey_id: number;
  signed_prekey: string;
  signed_prekey_signature: string;
  pq_last_resort_id: number;
  pq_last_resort_key: string;
  pq_last_resort_signature: string;
}

// GET /v1/keys/{accountId}/{deviceId|*}: what libsignal's PreKeyBundle needs, per device. Each bundle uses up one
// one-time EC prekey and one one-time Kyber prekey when the device has any left (else: no EC one-time key, and the
// Kyber last-resort key). Only for accounts the caller may talk to: others get 403, whether they exist or not.
export async function handleGetBundles(
  request: Request,
  env: Env,
  accountId: string,
  rawDevice: string,
): Promise<Response> {
  const session = await authenticateAccount(request, env);
  if (!session) return unauthorized();
  if (!(await mayTalk(env, session.id, accountId))) {
    return error(403, "forbidden", "Not an account you may talk to.");
  }
  const notFound = () => error(404, "not_found", "No keys for this account or device.");
  const deviceId = rawDevice === "*" ? null : parseDeviceId(rawDevice);
  if (rawDevice !== "*" && deviceId === null) return notFound();
  const identityKey = await env.DB.prepare("SELECT identity_key FROM account_identities WHERE account_id = ?")
    .bind(accountId)
    .first<string>("identity_key");
  if (!identityKey) return notFound();
  const columns = `device_id, registration_id, signed_prekey_id, signed_prekey, signed_prekey_signature,
    pq_last_resort_id, pq_last_resort_key, pq_last_resort_signature`;
  const { results: devices } = await (
    deviceId === null
      ? env.DB.prepare(`SELECT ${columns} FROM devices WHERE account_id = ? ORDER BY device_id`).bind(accountId)
      : env.DB.prepare(`SELECT ${columns} FROM devices WHERE account_id = ? AND device_id = ?`).bind(
          accountId,
          deviceId,
        )
  ).all<DeviceRow>();
  if (devices.length === 0) return notFound();

  // One-time keys: each DELETE ... RETURNING takes the lowest key id left, atomically, so two callers never get the
  // same one.
  const take = (table: "one_time_prekeys" | "pq_one_time_prekeys", columns: string, device: number) =>
    env.DB.prepare(
      `DELETE FROM ${table} WHERE rowid = (SELECT rowid FROM ${table} WHERE account_id = ? AND device_id = ?
         ORDER BY key_id LIMIT 1) RETURNING ${columns}`,
    ).bind(accountId, device);
  const taken = await env.DB.batch(
    devices.flatMap((d) => [
      take("one_time_prekeys", "key_id, public_key", d.device_id),
      take("pq_one_time_prekeys", "key_id, public_key, signature", d.device_id),
    ]),
  );
  const bundles = devices.map((d, i) => {
    const ec = taken[2 * i]?.results[0] as { key_id: number; public_key: string } | undefined;
    const pq = taken[2 * i + 1]?.results[0] as { key_id: number; public_key: string; signature: string } | undefined;
    return {
      deviceId: d.device_id,
      registrationId: d.registration_id,
      signedPreKey: { keyId: d.signed_prekey_id, publicKey: d.signed_prekey, signature: d.signed_prekey_signature },
      pqPreKey: pq
        ? { keyId: pq.key_id, publicKey: pq.public_key, signature: pq.signature }
        : { keyId: d.pq_last_resort_id, publicKey: d.pq_last_resort_key, signature: d.pq_last_resort_signature },
      ...(ec ? { preKey: { keyId: ec.key_id, publicKey: ec.public_key } } : {}),
    };
  });
  return json({ identityKey, devices: bundles });
}
