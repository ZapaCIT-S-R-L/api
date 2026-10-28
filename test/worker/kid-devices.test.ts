// Kid phones in the key directory, like parent phones: a paired kid session registers its device (with
// attestation), uploads its identity, signed and one-time prekeys, fetches the bundles of the accounts it may talk
// to (its family, and the connections it is shared in) and gets a chat token. Parents fetch kid bundles. Removing
// or unpairing a kid revokes its devices and sessions. Device changes are membership events for every account.
import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import {
  bearer,
  call,
  count,
  makeIssuer,
  resetJwksCache,
  sha256Hex,
  signInParent,
  stubJwks,
  workerRequest,
  type ErrorBody,
  type TestIssuer,
} from "./helpers";

let apple: TestIssuer;

beforeEach(async () => {
  resetJwksCache();
  apple = await makeIssuer();
  stubJwks([apple], []);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const typed = (type: number, length: number) => {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  bytes[0] = type;
  return bytes;
};
const ec = () => b64(typed(0x05, 33));
const kyber = () => b64(typed(0x08, 1569));
const sig = () => b64(crypto.getRandomValues(new Uint8Array(64)));

function deviceKeys(identityKey = ec(), registrationId = 777) {
  return {
    registrationId,
    identityKey,
    signedPreKey: { keyId: 1, publicKey: ec(), signature: sig() },
    pqLastResortPreKey: { keyId: 1, publicKey: kyber(), signature: sig() },
    preKeys: [1, 2].map((keyId) => ({ keyId, publicKey: ec() })),
    pqPreKeys: [2].map((keyId) => ({ keyId, publicKey: kyber(), signature: sig() })),
  };
}

type Auth = Record<string, string>;

function send(path: string, auth: Auth, body?: unknown, method = "POST"): Promise<Response> {
  return call(path, {
    method,
    headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const get = (path: string, auth: Auth) => call(path, { headers: auth });

async function errorCode(res: Response): Promise<string> {
  return (await res.json<ErrorBody>()).error.code;
}

// A parent with a family and one kid.
async function family(sub: string, kidName = "Mia") {
  const parent = await signInParent(apple, sub);
  const { id: familyId } = await (await send("/v1/families", parent.auth, { name: sub })).json<{ id: string }>();
  const kid = await (
    await send(`/v1/families/${familyId}/kids`, parent.auth, { nickname: kidName, avatar: "robot-1", grade: 1 })
  ).json<{ id: string }>();
  return { parent, familyId, kidId: kid.id };
}

// Pairs the kid's phone: a parent's code, redeemed by the phone. Returns the kid session's auth header.
async function pairKid(parentAuth: Auth, familyId: string, kidId: string): Promise<{ token: string; auth: Auth }> {
  const created = await send(`/v1/families/${familyId}/kids/${kidId}/pairing`, parentAuth);
  expect(created.status).toBe(201);
  const { code } = await created.json<{ code: string }>();
  const redeemed = await send("/v1/pairing/redeem", {}, { code });
  expect(redeemed.status).toBe(200);
  const { session } = await redeemed.json<{ session: { token: string } }>();
  return { token: session.token, auth: bearer(session.token) };
}

const register = (auth: Auth, body: unknown) => send("/v1/devices", auth, body);

async function registered(auth: Auth, body: unknown = deviceKeys()): Promise<number> {
  const res = await register(auth, body);
  expect(res.status).toBe(201);
  return (await res.json<{ deviceId: number }>()).deviceId;
}

async function connect(a: Auth, b: Auth): Promise<string> {
  const { code } = await (await send("/v1/connections/invitations", a)).json<{ code: string }>();
  const res = await send("/v1/connections/accept", b, { code });
  expect(res.status).toBe(201);
  return (await res.json<{ id: string }>()).id;
}

interface Bundle {
  deviceId: number;
  registrationId: number;
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  pqPreKey: { keyId: number; publicKey: string; signature: string };
  preKey?: { keyId: number; publicKey: string };
}

type OutboxEvent = { type: string; accountId?: string; deviceId?: number; registrationId?: number; familyId?: string };

async function outbox(): Promise<OutboxEvent[]> {
  const { results } = await env.DB.prepare("SELECT body FROM membership_outbox ORDER BY seq").all<{ body: string }>();
  return results.map((r) => JSON.parse(r.body) as OutboxEvent);
}

const deviceEvents = async () => (await outbox()).filter((e) => e.type.startsWith("device."));

function allowlisted(path: string, auth: Auth, body: unknown, allowlist: string, ip: string) {
  return worker.fetch(
    workerRequest(`https://api.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth, "cf-connecting-ip": ip },
      body: JSON.stringify(body),
    }),
    { ...env, ATTESTATION_POLICY: "allowlist", ATTESTATION_ALLOWLIST: allowlist },
  );
}

describe("a paired kid registers its phone", () => {
  it("POST /v1/devices with a kid session → 201, identity stored, kid session bound to the device", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const kid = await pairKid(parent.auth, familyId, kidId);
    const identityKey = ec();
    expect(await registered(kid.auth, deviceKeys(identityKey))).toBe(1);
    const identity = await env.DB.prepare("SELECT identity_key FROM account_identities WHERE account_id = ?")
      .bind(kidId)
      .first<string>("identity_key");
    expect(identity).toBe(identityKey);
    expect(await env.DB.prepare("SELECT device_id FROM kid_sessions").first("device_id")).toBe(1);
    expect(await count("one_time_prekeys")).toBe(2);
    expect(await count("pq_one_time_prekeys")).toBe(1);
  });

  it("a second phone of the same kid (paired again) is device 2 with the same identity", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const identityKey = ec();
    const first = await pairKid(parent.auth, familyId, kidId);
    const second = await pairKid(parent.auth, familyId, kidId);
    expect(await registered(first.auth, deviceKeys(identityKey))).toBe(1);
    expect(await registered(second.auth, deviceKeys(identityKey))).toBe(2);
    expect(await errorCode(await register((await pairKid(parent.auth, familyId, kidId)).auth, deviceKeys()))).toBe(
      "identity_mismatch",
    );
  });

  it("kid and parent device ids are per account: both start at 1", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const kid = await pairKid(parent.auth, familyId, kidId);
    expect(await registered(parent.auth)).toBe(1);
    expect(await registered(kid.auth)).toBe(1);
  });

  it("GET /v1/keys/prekeys counts the kid device's one-time prekeys", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const kid = await pairKid(parent.auth, familyId, kidId);
    expect(await errorCode(await get("/v1/keys/prekeys", kid.auth))).toBe("device_not_registered");
    await registered(kid.auth);
    const res = await get("/v1/keys/prekeys", kid.auth);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ preKeys: 2, pqPreKeys: 1 });
  });

  it("required attestation policy, no header → 403 attestation_failed, nothing stored", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const kid = await pairKid(parent.auth, familyId, kidId);
    const res = await worker.fetch(
      workerRequest("https://api.test/v1/devices", {
        method: "POST",
        headers: { "content-type": "application/json", ...kid.auth, "cf-connecting-ip": "10.9.0.1" },
        body: JSON.stringify(deviceKeys()),
      }),
      { ...env, ATTESTATION_POLICY: "required" },
    );
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("attestation_failed");
    expect(await count("devices")).toBe(0);
  });

  // ATTESTATION_ALLOWLIST lists parents' sign-in identities. A kid has none: its family's parents count.
  it("allowlist policy: a kid of an allowlisted parent's family may register without a header", async () => {
    const { parent, familyId, kidId } = await family("parent-allowlisted");
    const kid = await pairKid(parent.auth, familyId, kidId);
    const res = await allowlisted("/v1/devices", kid.auth, deviceKeys(), "apple:parent-allowlisted", "10.9.0.2");
    expect(res.status).toBe(201);
  });

  it("allowlist policy: a kid of a family without an allowlisted parent → 403", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const kid = await pairKid(parent.auth, familyId, kidId);
    const res = await allowlisted("/v1/devices", kid.auth, deviceKeys(), "apple:someone-else", "10.9.0.3");
    expect(res.status).toBe(403);
    expect(await count("devices")).toBe(0);
  });

  it("a kid removes its own device: its kid session is signed out", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const kid = await pairKid(parent.auth, familyId, kidId);
    const deviceId = await registered(kid.auth);
    expect((await send(`/v1/devices/${deviceId}`, kid.auth, undefined, "DELETE")).status).toBe(204);
    expect(await count("devices")).toBe(0);
    expect((await get("/v1/families", kid.auth)).status).toBe(401);
  });

  it("a kid can't remove a parent's device (only its own account's)", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const kid = await pairKid(parent.auth, familyId, kidId);
    await registered(parent.auth);
    await registered(kid.auth, deviceKeys(ec()));
    expect(await count("devices")).toBe(2);
    const res = await send("/v1/devices/1", kid.auth, undefined, "DELETE");
    expect(res.status).toBe(204);
    // The parent's device 1 is still there; the kid's device 1 is gone.
    const left = await env.DB.prepare("SELECT account_id FROM devices WHERE device_id = 1").all<{
      account_id: string;
    }>();
    expect(left.results.map((r) => r.account_id)).toEqual([parent.id]);
  });
});

describe("GET /v1/keys/{accountId}/{deviceId}: prekey bundles", () => {
  it("a parent fetches the kid's bundles; each fetch uses up one one-time prekey", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const kid = await pairKid(parent.auth, familyId, kidId);
    const keys = deviceKeys(ec(), 321);
    await registered(kid.auth, keys);

    const res = await get(`/v1/keys/${kidId}/*`, parent.auth);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json<{ identityKey: string; devices: Bundle[] }>();
    expect(body.identityKey).toBe(keys.identityKey);
    expect(body.devices).toEqual([
      {
        deviceId: 1,
        registrationId: 321,
        signedPreKey: keys.signedPreKey,
        pqPreKey: keys.pqPreKeys[0],
        preKey: keys.preKeys[0],
      },
    ]);
    const second = await (await get(`/v1/keys/${kidId}/1`, parent.auth)).json<{ devices: Bundle[] }>();
    // The Kyber one-time key is used up: the last-resort one now.
    expect(second.devices[0]?.pqPreKey).toEqual(keys.pqLastResortPreKey);
    expect(second.devices[0]?.preKey).toEqual(keys.preKeys[1]);
    const third = await (await get(`/v1/keys/${kidId}/1`, parent.auth)).json<{ devices: Bundle[] }>();
    expect(third.devices[0]).not.toHaveProperty("preKey");
    expect(await count("one_time_prekeys")).toBe(0);
  });

  it("a kid fetches its parent's bundles, a sibling's, and its own other devices", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const { id: siblingId } = await (
      await send(`/v1/families/${familyId}/kids`, parent.auth, { nickname: "Leo", avatar: "robot-2" })
    ).json<{ id: string }>();
    const kid = await pairKid(parent.auth, familyId, kidId);
    const sibling = await pairKid(parent.auth, familyId, siblingId);
    await registered(parent.auth);
    await registered(sibling.auth);
    await registered(kid.auth);
    expect((await get(`/v1/keys/${parent.id}/*`, kid.auth)).status).toBe(200);
    expect((await get(`/v1/keys/${siblingId}/1`, kid.auth)).status).toBe(200);
    expect((await get(`/v1/keys/${kidId}/*`, kid.auth)).status).toBe(200);
  });

  it("a kid shared in a connection fetches the other family's parents and shared kids", async () => {
    const a = await family("ana", "Mia");
    const b = await family("bob", "Tom");
    const connectionId = await connect(a.parent.auth, b.parent.auth);
    const mia = await pairKid(a.parent.auth, a.familyId, a.kidId);
    const tom = await pairKid(b.parent.auth, b.familyId, b.kidId);
    await registered(b.parent.auth);
    await registered(tom.auth);
    await registered(mia.auth);

    // Not shared yet: Bob's family is outside Mia's scopes.
    const before = await get(`/v1/keys/${b.parent.id}/*`, mia.auth);
    expect(before.status).toBe(403);
    expect(await errorCode(before)).toBe("forbidden");

    expect(
      (await send(`/v1/connections/${connectionId}/shared-kids/${a.kidId}`, a.parent.auth, {}, "PUT")).status,
    ).toBe(204);
    expect((await get(`/v1/keys/${b.parent.id}/*`, mia.auth)).status).toBe(200);
    // Tom isn't shared: Mia may not fetch him, and he may not fetch her... until Bob shares him.
    expect((await get(`/v1/keys/${b.kidId}/*`, mia.auth)).status).toBe(403);
    expect(
      (await send(`/v1/connections/${connectionId}/shared-kids/${b.kidId}`, b.parent.auth, {}, "PUT")).status,
    ).toBe(204);
    expect((await get(`/v1/keys/${b.kidId}/*`, mia.auth)).status).toBe(200);
    expect((await get(`/v1/keys/${a.kidId}/*`, tom.auth)).status).toBe(200);
    // Bob (other family's parent) fetches the shared kid.
    expect((await get(`/v1/keys/${a.kidId}/*`, b.parent.auth)).status).toBe(200);
  });

  it("a kid can't fetch accounts outside its family and shared connections → 403", async () => {
    const a = await family("ana");
    const b = await family("bob");
    const mia = await pairKid(a.parent.auth, a.familyId, a.kidId);
    await registered(b.parent.auth);
    const tom = await pairKid(b.parent.auth, b.familyId, b.kidId);
    await registered(tom.auth);
    expect((await get(`/v1/keys/${b.parent.id}/*`, mia.auth)).status).toBe(403);
    expect((await get(`/v1/keys/${b.kidId}/1`, mia.auth)).status).toBe(403);
    // Connected families, kid not shared: still 403.
    await connect(a.parent.auth, b.parent.auth);
    expect((await get(`/v1/keys/${b.parent.id}/*`, mia.auth)).status).toBe(403);
    // An unknown account looks the same.
    expect((await get(`/v1/keys/${crypto.randomUUID()}/*`, mia.auth)).status).toBe(403);
    // Nothing was used up.
    expect(await count("one_time_prekeys")).toBe(4);
  });

  it("a parent can't fetch another family's kid unless it is shared with them", async () => {
    const a = await family("ana");
    const b = await family("bob");
    const tom = await pairKid(b.parent.auth, b.familyId, b.kidId);
    await registered(tom.auth);
    expect((await get(`/v1/keys/${b.kidId}/*`, a.parent.auth)).status).toBe(403);
    const connectionId = await connect(a.parent.auth, b.parent.auth);
    // Parents of connected families may talk to each other.
    expect((await get(`/v1/keys/${b.parent.id}/*`, a.parent.auth)).status).toBe(404);
    expect((await get(`/v1/keys/${b.kidId}/*`, a.parent.auth)).status).toBe(403);
    await send(`/v1/connections/${connectionId}/shared-kids/${b.kidId}`, b.parent.auth, {}, "PUT");
    expect((await get(`/v1/keys/${b.kidId}/*`, a.parent.auth)).status).toBe(200);
  });

  it("an allowed account without an identity or that device → 404 not_found", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const kid = await pairKid(parent.auth, familyId, kidId);
    expect(await errorCode(await get(`/v1/keys/${kidId}/*`, parent.auth))).toBe("not_found");
    await registered(kid.auth);
    expect((await get(`/v1/keys/${kidId}/2`, parent.auth)).status).toBe(404);
    expect((await get(`/v1/keys/${kidId}/0`, parent.auth)).status).toBe(404);
    expect((await get(`/v1/keys/${kidId}/x`, parent.auth)).status).toBe(404);
  });

  it("without a session → 401; POST → 405", async () => {
    const { kidId } = await family("ana");
    expect((await get(`/v1/keys/${kidId}/*`, {})).status).toBe(401);
    expect((await send(`/v1/keys/${kidId}/*`, {}, {})).status).toBe(405);
  });
});

describe("GET /v1/accounts/{accountId}/identity for family members", () => {
  it("a parent reads the kid's identity; an outsider gets 404", async () => {
    const a = await family("ana");
    const b = await family("bob");
    const kid = await pairKid(a.parent.auth, a.familyId, a.kidId);
    const identityKey = ec();
    await registered(kid.auth, deviceKeys(identityKey));
    const res = await get(`/v1/accounts/${a.kidId}/identity`, a.parent.auth);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ identityKey, changes: [] });
    expect((await get(`/v1/accounts/${a.kidId}/identity`, kid.auth)).status).toBe(200);
    expect((await get(`/v1/accounts/${a.kidId}/identity`, b.parent.auth)).status).toBe(404);
  });
});

describe("POST /v1/chat/token for kids", () => {
  async function jwks(): Promise<JSONWebKeySet> {
    return (await call("/.well-known/jwks.json")).json<JSONWebKeySet>();
  }

  it("a kid with a registered device gets a token: sub = kid id, role kid, its device and scopes", async () => {
    const a = await family("ana");
    const b = await family("bob");
    const connectionId = await connect(a.parent.auth, b.parent.auth);
    await send(`/v1/connections/${connectionId}/shared-kids/${a.kidId}`, a.parent.auth, {}, "PUT");
    const kid = await pairKid(a.parent.auth, a.familyId, a.kidId);
    expect(await errorCode(await send("/v1/chat/token", kid.auth))).toBe("device_required");
    const deviceId = await registered(kid.auth);
    const res = await send("/v1/chat/token", kid.auth);
    expect(res.status).toBe(200);
    const { token } = await res.json<{ token: string }>();
    const { payload } = await jwtVerify(token, createLocalJWKSet(await jwks()), { audience: "chat.localhost" });
    expect(payload.sub).toBe(a.kidId);
    expect(payload.role).toBe("kid");
    expect(payload.dev).toBe(deviceId);
    expect(payload.conv).toEqual([`family:${a.familyId}`, `connection:${connectionId}`]);
    // Kids have no session epoch (logout-all is for parents): no `sep`, which the services read as 0.
    expect(payload.sep).toBeUndefined();
  });

  it("a parent's token carries the registered device and the family scope (no seeded source)", async () => {
    const { parent, familyId } = await family("ana");
    const deviceId = await registered(parent.auth);
    const { token } = await (await send("/v1/chat/token", parent.auth)).json<{ token: string }>();
    const { payload } = await jwtVerify(token, createLocalJWKSet(await jwks()), { audience: "chat.localhost" });
    expect(payload).toMatchObject({
      sub: parent.id,
      role: "parent",
      dev: deviceId,
      conv: [`family:${familyId}`],
      sep: 0,
    });
  });
});

describe("removing or unpairing a kid revokes its phones", () => {
  it("DELETE /v1/families/{familyId}/kids/{kidId}/pairing: kid sessions signed out, devices and keys removed, kid kept", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const kid = await pairKid(parent.auth, familyId, kidId);
    const other = await pairKid(parent.auth, familyId, kidId);
    const identityKey = ec();
    await registered(kid.auth, deviceKeys(identityKey));
    await registered(other.auth, deviceKeys(identityKey));
    const open = await send(`/v1/families/${familyId}/kids/${kidId}/pairing`, parent.auth);
    const { code } = await open.json<{ code: string }>();

    const res = await send(`/v1/families/${familyId}/kids/${kidId}/pairing`, parent.auth, undefined, "DELETE");
    expect(res.status).toBe(204);
    expect((await get("/v1/families", kid.auth)).status).toBe(401);
    expect((await get("/v1/families", other.auth)).status).toBe(401);
    expect(await count("kid_sessions")).toBe(0);
    expect(await count("devices")).toBe(0);
    expect(await count("one_time_prekeys")).toBe(0);
    expect(await count("kids")).toBe(1);
    // Open pairing codes for the kid are revoked too.
    expect((await send("/v1/pairing/redeem", {}, { code })).status).toBe(410);
    const removed = (await deviceEvents()).filter((e) => e.type === "device.removed");
    expect(removed.map((e) => [e.accountId, e.deviceId])).toEqual([
      [kidId, 1],
      [kidId, 2],
    ]);
  });

  it("DELETE .../sessions/{sessionId}: that phone's device and keys go with its session; the other phone stays", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const lost = await pairKid(parent.auth, familyId, kidId);
    const kept = await pairKid(parent.auth, familyId, kidId);
    const identityKey = ec();
    const lostDevice = await registered(lost.auth, deviceKeys(identityKey));
    const keptDevice = await registered(kept.auth, deviceKeys(identityKey));
    const sessionsPath = `/v1/families/${familyId}/kids/${kidId}/sessions`;
    const lostHash = await sha256Hex(lost.token);
    const lostRow = await env.DB.prepare("SELECT id FROM kid_sessions WHERE token_hash = ?")
      .bind(lostHash)
      .first<{ id: string }>();

    expect((await send(`${sessionsPath}/${lostRow?.id}`, parent.auth, undefined, "DELETE")).status).toBe(204);
    expect((await get("/v1/families", lost.auth)).status).toBe(401);
    expect((await get("/v1/families", kept.auth)).status).toBe(200);
    const devices = await env.DB.prepare("SELECT device_id FROM devices WHERE account_id = ?")
      .bind(kidId)
      .all<{ device_id: number }>();
    expect(devices.results.map((d) => d.device_id)).toEqual([keptDevice]);
    const prekeys = await env.DB.prepare("SELECT DISTINCT device_id FROM one_time_prekeys WHERE account_id = ?")
      .bind(kidId)
      .all<{ device_id: number }>();
    expect(prekeys.results.map((d) => d.device_id)).toEqual([keptDevice]);
    const removed = (await deviceEvents()).filter((e) => e.type === "device.removed");
    expect(removed.map((e) => [e.accountId, e.deviceId])).toEqual([[kidId, lostDevice]]);
  });

  it("DELETE .../sessions/{sessionId} of a phone without a device removes no device", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const unregistered = await pairKid(parent.auth, familyId, kidId);
    const other = await pairKid(parent.auth, familyId, kidId);
    await registered(other.auth);
    const row = await env.DB.prepare("SELECT id FROM kid_sessions WHERE token_hash = ?")
      .bind(await sha256Hex(unregistered.token))
      .first<{ id: string }>();
    const path = `/v1/families/${familyId}/kids/${kidId}/sessions/${row?.id}`;
    expect((await send(path, parent.auth, undefined, "DELETE")).status).toBe(204);
    expect(await count("devices")).toBe(1);
    expect((await deviceEvents()).filter((e) => e.type === "device.removed")).toEqual([]);
  });

  it("after unpairing, a fresh pairing may replace the kid's identity (PUT /v1/keys/identity)", async () => {
    const { parent, familyId, kidId } = await family("ana");
    await registered((await pairKid(parent.auth, familyId, kidId)).auth, deviceKeys(ec()));
    await send(`/v1/families/${familyId}/kids/${kidId}/pairing`, parent.auth, undefined, "DELETE");
    const fresh = await pairKid(parent.auth, familyId, kidId);
    const newKey = ec();
    expect(await errorCode(await register(fresh.auth, deviceKeys(newKey)))).toBe("identity_mismatch");
    const res = await send("/v1/keys/identity", fresh.auth, deviceKeys(newKey), "PUT");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deviceId: 1 });
    const identity = await (
      await get(`/v1/accounts/${kidId}/identity`, parent.auth)
    ).json<{
      identityKey: string;
      changes: unknown[];
    }>();
    expect(identity.identityKey).toBe(newKey);
    expect(identity.changes).toHaveLength(1);
  });

  it("a kid session older than 10 minutes can't replace the identity", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const kid = await pairKid(parent.auth, familyId, kidId);
    await registered(kid.auth, deviceKeys(ec()));
    await env.DB.prepare("UPDATE kid_sessions SET created_at = ?")
      .bind(new Date(Date.now() - 11 * 60_000).toISOString())
      .run();
    expect(await errorCode(await send("/v1/keys/identity", kid.auth, deviceKeys(ec()), "PUT"))).toBe(
      "reauthentication_required",
    );
  });

  it("DELETE /v1/families/{familyId}/kids/{kidId}: the kid, its sessions, devices, keys and identity go", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const kid = await pairKid(parent.auth, familyId, kidId);
    await registered(kid.auth);
    await registered(parent.auth);

    const res = await send(`/v1/families/${familyId}/kids/${kidId}`, parent.auth, undefined, "DELETE");
    expect(res.status).toBe(204);
    expect((await get("/v1/families", kid.auth)).status).toBe(401);
    expect(await count("kids")).toBe(0);
    expect(await count("kid_sessions")).toBe(0);
    const left = await env.DB.prepare("SELECT account_id FROM devices").all<{ account_id: string }>();
    expect(left.results.map((r) => r.account_id)).toEqual([parent.id]);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM account_identities WHERE account_id = ?").bind(kidId).first("n"),
    ).toBe(0);
    const events = (await outbox()).slice(-3);
    expect(events.map((e) => [e.type, e.accountId])).toEqual([
      ["device.removed", kidId],
      ["family.member_removed", kidId],
      ["account.deleted", kidId],
    ]);
    expect(events[1]?.familyId).toBe(familyId);
    expect((await send(`/v1/families/${familyId}/kids/${kidId}`, parent.auth, undefined, "DELETE")).status).toBe(404);
  });

  it("only a parent of the kid's family may remove or unpair it", async () => {
    const a = await family("ana");
    const b = await family("bob");
    const kid = await pairKid(a.parent.auth, a.familyId, a.kidId);
    for (const path of [
      `/v1/families/${a.familyId}/kids/${a.kidId}`,
      `/v1/families/${a.familyId}/kids/${a.kidId}/pairing`,
    ]) {
      expect((await send(path, b.parent.auth, undefined, "DELETE")).status).toBe(404);
      expect((await send(path, kid.auth, undefined, "DELETE")).status).toBe(401);
      expect((await send(path, {}, undefined, "DELETE")).status).toBe(401);
    }
    expect(await count("kids")).toBe(2);
    expect(await count("kid_sessions")).toBe(1);
  });
});

describe("parent-only paths stay parent-only", () => {
  it("a kid session gets 401 on logout-all, families admin and pairing", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const kid = await pairKid(parent.auth, familyId, kidId);
    expect((await send("/v1/auth/logout-all", kid.auth)).status).toBe(401);
    expect((await get("/v1/me", kid.auth)).status).toBe(401);
    expect((await send("/v1/families", kid.auth, {})).status).toBe(401);
    expect((await send(`/v1/families/${familyId}/kids/${kidId}/pairing`, kid.auth)).status).toBe(401);
    expect((await send("/v1/connections/invitations", kid.auth)).status).toBe(401);
  });
});

describe("device membership events", () => {
  it("registering emits device.upserted for kids and parents; removing emits device.removed", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const kid = await pairKid(parent.auth, familyId, kidId);
    await registered(kid.auth, deviceKeys(ec(), 11));
    await registered(parent.auth, deviceKeys(ec(), 22));
    // A retried registration (same keys, same session) emits nothing new.
    expect((await deviceEvents()).length).toBe(2);
    await send("/v1/devices/1", kid.auth, undefined, "DELETE");
    const events = await deviceEvents();
    expect(
      events.map((e) => ({ type: e.type, accountId: e.accountId, deviceId: e.deviceId, reg: e.registrationId })),
    ).toEqual([
      { type: "device.upserted", accountId: kidId, deviceId: 1, reg: 11 },
      { type: "device.upserted", accountId: parent.id, deviceId: 1, reg: 22 },
      { type: "device.removed", accountId: kidId, deviceId: 1, reg: undefined },
    ]);
    for (const e of events) {
      expect(e).toMatchObject({ v: 1 });
      expect((e as unknown as { id: string }).id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it("removing an unknown device emits nothing", async () => {
    const { parent } = await family("ana");
    expect((await send("/v1/devices/5", parent.auth, undefined, "DELETE")).status).toBe(404);
    expect(await deviceEvents()).toEqual([]);
  });

  it("an identity change: removed for the old other devices, upserted for the new device 1", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const identityKey = ec();
    await registered((await pairKid(parent.auth, familyId, kidId)).auth, deviceKeys(identityKey));
    await registered((await pairKid(parent.auth, familyId, kidId)).auth, deviceKeys(identityKey));
    const fresh = await pairKid(parent.auth, familyId, kidId);
    expect((await send("/v1/keys/identity", fresh.auth, deviceKeys(ec(), 99), "PUT")).status).toBe(200);
    const events = (await deviceEvents()).slice(2);
    expect(events.map((e) => [e.type, e.deviceId, e.registrationId])).toEqual([
      ["device.removed", 2, undefined],
      ["device.upserted", 1, 99],
    ]);
    // The other kid sessions are signed out; the fresh one is bound to device 1.
    expect(await count("kid_sessions")).toBe(1);
  });

  it("the purge of inactive devices emits device.removed and signs out the kid session", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const kid = await pairKid(parent.auth, familyId, kidId);
    await registered(kid.auth);
    await env.DB.prepare("UPDATE devices SET last_seen_at = ?")
      .bind(new Date(Date.now() - 91 * 86_400_000).toISOString())
      .run();
    await worker.scheduled(createScheduledController({ cron: "17 * * * *" }), env);
    expect(await count("devices")).toBe(0);
    expect(await count("kid_sessions")).toBe(0);
    expect((await deviceEvents()).map((e) => [e.type, e.accountId, e.deviceId])).toEqual([
      ["device.upserted", kidId, 1],
      ["device.removed", kidId, 1],
    ]);
  });

  it("a kid request keeps its device active (last_seen_at)", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const kid = await pairKid(parent.auth, familyId, kidId);
    await registered(kid.auth);
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await env.DB.prepare("UPDATE devices SET last_seen_at = ?").bind(old).run();
    await get("/v1/families", kid.auth);
    const seen = await env.DB.prepare("SELECT last_seen_at FROM devices").first<string>("last_seen_at");
    expect(seen && seen > old).toBe(true);
  });
});

describe("deleting a family removes its kids' devices (no foreign key to parents any more)", () => {
  it("devices and identities of kids go with the kid row", async () => {
    const { parent, familyId, kidId } = await family("ana");
    await registered((await pairKid(parent.auth, familyId, kidId)).auth);
    await env.DB.prepare("DELETE FROM families WHERE id = ?").bind(familyId).run();
    expect(await count("kids")).toBe(0);
    expect(await count("devices")).toBe(0);
    expect(await count("account_identities")).toBe(0);
  });

  it("devices and identities of a parent go with the parent row", async () => {
    const { parent } = await family("ana");
    await registered(parent.auth);
    await env.DB.prepare("DELETE FROM parents WHERE id = ?").bind(parent.id).run();
    expect(await count("devices")).toBe(0);
    expect(await count("account_identities")).toBe(0);
    expect(await count("one_time_prekeys")).toBe(0);
  });
});
