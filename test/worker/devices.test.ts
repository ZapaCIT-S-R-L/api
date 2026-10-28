// Device registration with the key directory (POST /v1/devices), removing devices, the prekey count, the account
// identity, and the 90-day expiry. Keys are random bytes with libsignal's type bytes and sizes: the server checks
// shapes and stores public keys only.
import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDeviceKeys as parsedKeys, storeDevice } from "../../src/devices";
import worker from "../../src/index";
import { authenticate } from "../../src/sessions";
import {
  ADULT,
  appleClaims,
  bearer,
  call,
  count,
  makeIssuer,
  postJson,
  resetJwksCache,
  stubJwks,
  workerRequest,
  type ErrorBody,
  type SignInBody,
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

function deviceKeys(identityKey = ec(), overrides: Record<string, unknown> = {}) {
  return {
    registrationId: 4242,
    identityKey,
    signedPreKey: { keyId: 1, publicKey: ec(), signature: sig() },
    pqLastResortPreKey: { keyId: 1, publicKey: kyber(), signature: sig() },
    preKeys: [1, 2, 3].map((keyId) => ({ keyId, publicKey: ec() })),
    pqPreKeys: [2, 3].map((keyId) => ({ keyId, publicKey: kyber(), signature: sig() })),
    ...overrides,
  };
}

async function signIn(sub = "parent-1"): Promise<SignInBody> {
  const res = await postJson("/v1/auth/apple", {
    identityToken: await apple.sign(appleClaims({ sub })),
    ageRange: ADULT,
  });
  return res.json<SignInBody>();
}

const register = (token: string, body: unknown, headers: Record<string, string> = {}) =>
  call("/v1/devices", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token), ...headers },
    body: JSON.stringify(body),
  });

async function outboxEvents(): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT body, sent_at FROM membership_outbox ORDER BY seq").all<{
    body: string;
    sent_at: string | null;
  }>();
  return results.map((r) => ({ ...(JSON.parse(r.body) as Record<string, unknown>), sent: r.sent_at !== null }));
}

async function authenticateToken(token: string) {
  const session = await authenticate(workerRequest("https://api.test/", { headers: bearer(token) }), env);
  if (!session) throw new Error("no session");
  return session;
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect((await res.json<ErrorBody>()).error.code).toBe(code);
}

describe("POST /v1/devices", () => {
  it("without a session → 401", async () => {
    const res = await call("/v1/devices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("the first device gets id 1 and sets the account identity; the next phone gets 2", async () => {
    const identityKey = ec();
    const a = await signIn();
    const first = await register(a.session.token, deviceKeys(identityKey));
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ deviceId: 1 });
    const b = await signIn();
    expect(await (await register(b.session.token, deviceKeys(identityKey))).json()).toEqual({ deviceId: 2 });
    expect(await count("devices")).toBe(2);
  });

  it("binds the session to the device on the server", async () => {
    const a = await signIn();
    await register(a.session.token, deviceKeys());
    const row = await env.DB.prepare("SELECT device_id FROM sessions").first("device_id");
    expect(row).toBe(1);
  });

  it("another identity key than the account's → 409 identity_mismatch, nothing stored", async () => {
    const a = await signIn();
    await register(a.session.token, deviceKeys());
    const b = await signIn();
    await expectError(await register(b.session.token, deviceKeys(ec())), 409, "identity_mismatch");
    expect(await count("devices")).toBe(1);
  });

  it("a retry on the same session with the same keys → the same device id", async () => {
    const a = await signIn();
    const body = deviceKeys();
    expect(await (await register(a.session.token, body)).json()).toEqual({ deviceId: 1 });
    const again = await register(a.session.token, body);
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual({ deviceId: 1 });
    expect(await count("devices")).toBe(1);
  });

  it("the same session with other keys → 409 device_already_registered", async () => {
    const identityKey = ec();
    const a = await signIn();
    await register(a.session.token, deviceKeys(identityKey));
    await expectError(await register(a.session.token, deviceKeys(identityKey)), 409, "device_already_registered");
  });

  it("a reinstall (new session, same identity) is a new device", async () => {
    const identityKey = ec();
    const a = await signIn();
    await register(a.session.token, deviceKeys(identityKey));
    const reinstall = await signIn();
    expect(await (await register(reinstall.session.token, deviceKeys(identityKey))).json()).toEqual({ deviceId: 2 });
  });

  it("127 devices → 409 too_many_devices", async () => {
    const identityKey = ec();
    const a = await signIn();
    await register(a.session.token, deviceKeys(identityKey));
    const now = new Date().toISOString();
    await env.DB.batch(
      Array.from({ length: 126 }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO devices (account_id, device_id, registration_id, signed_prekey_id, signed_prekey,
             signed_prekey_signature, pq_last_resort_id, pq_last_resort_key, pq_last_resort_signature, created_at,
             last_seen_at) VALUES (?, ?, 1, 1, 'k', 's', 1, 'k', 's', ?, ?)`,
        ).bind(a.parent.id, i + 2, now, now),
      ),
    );
    const b = await signIn();
    await expectError(await register(b.session.token, deviceKeys(identityKey)), 409, "too_many_devices");
  });

  it("the lowest free id is reused after a device is removed", async () => {
    const identityKey = ec();
    const a = await signIn();
    await register(a.session.token, deviceKeys(identityKey));
    const b = await signIn();
    await register(b.session.token, deviceKeys(identityKey));
    await call("/v1/devices/1", { method: "DELETE", headers: bearer(b.session.token) });
    const c = await signIn();
    expect(await (await register(c.session.token, deviceKeys(identityKey))).json()).toEqual({ deviceId: 1 });
  });

  it("stores only what it was sent: public keys and signatures", async () => {
    const a = await signIn();
    const body = deviceKeys();
    await register(a.session.token, body);
    expect(await count("one_time_prekeys")).toBe(3);
    expect(await count("pq_one_time_prekeys")).toBe(2);
    const device = await env.DB.prepare("SELECT signed_prekey, pq_last_resort_key FROM devices").first();
    expect(device).toEqual({
      signed_prekey: body.signedPreKey.publicKey,
      pq_last_resort_key: body.pqLastResortPreKey.publicKey,
    });
  });

  it("a full upload (100 + 100 prekeys, over 200 KiB) is accepted", async () => {
    const a = await signIn();
    const body = deviceKeys(ec(), {
      preKeys: Array.from({ length: 100 }, (_, keyId) => ({ keyId, publicKey: ec() })),
      pqPreKeys: Array.from({ length: 100 }, (_, keyId) => ({
        keyId: keyId + 2,
        publicKey: kyber(),
        signature: sig(),
      })),
    });
    expect(JSON.stringify(body).length).toBeGreaterThan(200_000);
    expect((await register(a.session.token, body)).status).toBe(201);
  });

  // Regression guard for the threat model (README, "Security notes"): the server does NOT verify prekey signatures.
  // libsignal on the phones does, when it builds a session from a bundle, and refuses a bad one. If this test ever
  // fails because the server started checking signatures, update the README and the contract with it.
  it("accepts a 64-byte all-zero signature: signatures are verified by the phones, not the server", async () => {
    const a = await signIn();
    const zero = b64(new Uint8Array(64));
    const body = deviceKeys(ec(), {
      signedPreKey: { keyId: 1, publicKey: ec(), signature: zero },
      pqLastResortPreKey: { keyId: 1, publicKey: kyber(), signature: zero },
      pqPreKeys: [{ keyId: 2, publicKey: kyber(), signature: zero }],
    });
    expect((await register(a.session.token, body)).status).toBe(201);
  });

  it("pushToken is optional and accepted", async () => {
    const a = await signIn();
    expect((await register(a.session.token, deviceKeys(ec(), { pushToken: "fcm-token" }))).status).toBe(201);
  });

  const invalidKeys: [string, (k: ReturnType<typeof deviceKeys>) => unknown][] = [
    ["identity key of the wrong type", (k) => ({ ...k, identityKey: b64(typed(0x08, 33)) })],
    ["identity key of the wrong size", (k) => ({ ...k, identityKey: b64(typed(0x05, 32)) })],
    [
      "signed prekey signature too short",
      (k) => ({ ...k, signedPreKey: { ...k.signedPreKey, signature: b64(new Uint8Array(63)) } }),
    ],
    [
      "Kyber last-resort key of the wrong size",
      (k) => ({ ...k, pqLastResortPreKey: { ...k.pqLastResortPreKey, publicKey: b64(typed(0x08, 1568)) } }),
    ],
    [
      "an EC key where Kyber belongs",
      (k) => ({ ...k, pqLastResortPreKey: { ...k.pqLastResortPreKey, publicKey: ec() } }),
    ],
    ["one-time prekey of the wrong type", (k) => ({ ...k, preKeys: [{ keyId: 9, publicKey: kyber() }] })],
    [
      "repeated one-time prekey ids",
      (k) => ({
        ...k,
        preKeys: [
          { keyId: 5, publicKey: ec() },
          { keyId: 5, publicKey: ec() },
        ],
      }),
    ],
    [
      "repeated Kyber prekey ids",
      (k) => ({
        ...k,
        pqPreKeys: [
          { keyId: 7, publicKey: kyber(), signature: sig() },
          { keyId: 7, publicKey: kyber(), signature: sig() },
        ],
      }),
    ],
    [
      "Kyber one-time prekey with the last-resort id",
      (k) => ({ ...k, pqPreKeys: [{ keyId: 1, publicKey: kyber(), signature: sig() }] }),
    ],
    ["not base64", (k) => ({ ...k, identityKey: "!!!" })],
  ];
  for (const [why, mutate] of invalidKeys) {
    it(`${why} → 400 invalid_keys`, async () => {
      const a = await signIn();
      await expectError(await register(a.session.token, mutate(deviceKeys())), 400, "invalid_keys");
      expect(await count("devices")).toBe(0);
    });
  }

  const invalidShape: [string, (k: ReturnType<typeof deviceKeys>) => unknown][] = [
    ["registration id 0", (k) => ({ ...k, registrationId: 0 })],
    ["registration id too big", (k) => ({ ...k, registrationId: 16384 })],
    [
      "101 one-time prekeys",
      (k) => ({ ...k, preKeys: Array.from({ length: 101 }, (_, keyId) => ({ keyId, publicKey: ec() })) }),
    ],
    ["key id over 24 bits", (k) => ({ ...k, signedPreKey: { ...k.signedPreKey, keyId: 16_777_216 } })],
    ["no signed prekey", (k) => ({ ...k, signedPreKey: undefined })],
    ["an unknown field", (k) => ({ ...k, privateKey: "nope" })],
  ];
  for (const [why, mutate] of invalidShape) {
    it(`${why} → 400 invalid_request`, async () => {
      const a = await signIn();
      await expectError(await register(a.session.token, mutate(deviceKeys())), 400, "invalid_request");
    });
  }

  it("with the required attestation policy, no header → 403 and nothing stored", async () => {
    const a = await signIn();
    const request = workerRequest("https://api.test/v1/devices", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(a.session.token), "cf-connecting-ip": "10.7.7.7" },
      body: JSON.stringify(deviceKeys()),
    });
    await expectError(
      await worker.fetch(request, { ...env, ATTESTATION_POLICY: "required" }),
      403,
      "attestation_failed",
    );
    expect(await count("devices")).toBe(0);
  });

  it("with the allowlist policy, an allowlisted account may register without a header", async () => {
    const a = await signIn("parent-allowlisted");
    const request = workerRequest("https://api.test/v1/devices", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(a.session.token), "cf-connecting-ip": "10.7.7.8" },
      body: JSON.stringify(deviceKeys()),
    });
    const res = await worker.fetch(request, {
      ...env,
      ATTESTATION_POLICY: "allowlist",
      ATTESTATION_ALLOWLIST: "apple:parent-allowlisted",
    });
    expect(res.status).toBe(201);
  });
});

// Regression (security review 2026-10-27, L1): the session is read at the start of a registration; the write must
// still require that session to exist and be unbound, so a logout in between or a parallel registration on the
// same session can't leave extra or orphaned devices.
describe("registration is atomic with its session", () => {
  it("parallel registrations on one session with the same keys → one device, all answers the same id", async () => {
    const a = await signIn();
    const body = deviceKeys();
    const answers = await Promise.all(Array.from({ length: 5 }, () => register(a.session.token, body)));
    expect(answers.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    const ids = await Promise.all(answers.map((r) => r.json<{ deviceId: number }>()));
    expect(new Set(ids.map((i) => i.deviceId)).size).toBe(1);
    expect(await count("devices")).toBe(1);
  });

  it("parallel registrations on one session with different keys → one device, the others 409", async () => {
    const identityKey = ec();
    const a = await signIn();
    const answers = await Promise.all(
      Array.from({ length: 4 }, () => register(a.session.token, deviceKeys(identityKey))),
    );
    const statuses = answers.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409]);
    expect(await count("devices")).toBe(1);
  });

  it("a session signed out after it was read can't register a device", async () => {
    const a = await signIn();
    const session = await authenticateToken(a.session.token);
    await call("/v1/auth/logout", { method: "POST", headers: bearer(a.session.token) });
    const stored = await storeDevice(env, session, 1, parsedKeys(deviceKeys()), new Date().toISOString());
    expect(stored).toBe(false);
    expect(await count("devices")).toBe(0);
  });

  it("logout then register → 401, no device", async () => {
    const a = await signIn();
    await call("/v1/auth/logout", { method: "POST", headers: bearer(a.session.token) });
    expect((await register(a.session.token, deviceKeys())).status).toBe(401);
    expect(await count("devices")).toBe(0);
  });
});

describe("GET /v1/accounts/{id}/identity", () => {
  it("own account without a device yet → 404", async () => {
    const a = await signIn();
    await expectError(
      await call(`/v1/accounts/${a.parent.id}/identity`, { headers: bearer(a.session.token) }),
      404,
      "not_found",
    );
  });

  it("own account → the identity key, no changes", async () => {
    const identityKey = ec();
    const a = await signIn();
    await register(a.session.token, deviceKeys(identityKey));
    const res = await call(`/v1/accounts/${a.parent.id}/identity`, { headers: bearer(a.session.token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ identityKey, changes: [] });
  });

  it("another account → 404 (no chats between accounts yet)", async () => {
    const a = await signIn("parent-a");
    await register(a.session.token, deviceKeys());
    const b = await signIn("parent-b");
    await expectError(
      await call(`/v1/accounts/${a.parent.id}/identity`, { headers: bearer(b.session.token) }),
      404,
      "not_found",
    );
  });

  it("without a session → 401", async () => {
    expect((await call("/v1/accounts/x/identity")).status).toBe(401);
  });
});

describe("GET /v1/keys/prekeys", () => {
  it("before registration → 409 device_not_registered", async () => {
    const a = await signIn();
    await expectError(
      await call("/v1/keys/prekeys", { headers: bearer(a.session.token) }),
      409,
      "device_not_registered",
    );
  });

  it("counts this device's one-time prekeys", async () => {
    const a = await signIn();
    await register(a.session.token, deviceKeys());
    const res = await call("/v1/keys/prekeys", { headers: bearer(a.session.token) });
    expect(await res.json()).toEqual({ preKeys: 3, pqPreKeys: 2 });
  });
});

describe("DELETE /v1/devices/{id}", () => {
  it("removes the device and its keys", async () => {
    const a = await signIn();
    await register(a.session.token, deviceKeys());
    const res = await call("/v1/devices/1", { method: "DELETE", headers: bearer(a.session.token) });
    expect(res.status).toBe(204);
    expect(await count("devices")).toBe(0);
    expect(await count("one_time_prekeys")).toBe(0);
    expect(await count("pq_one_time_prekeys")).toBe(0);
  });

  // Regression (security review 2026-10-27, H2): removing a lost phone must sign it out, not just unbind it.
  it("signs out the removed device's sessions; the other phone stays signed in", async () => {
    const identityKey = ec();
    const lost = await signIn();
    await register(lost.session.token, deviceKeys(identityKey));
    const other = await signIn();
    await register(other.session.token, deviceKeys(identityKey));
    expect((await call("/v1/devices/1", { method: "DELETE", headers: bearer(other.session.token) })).status).toBe(204);
    for (const path of ["/v1/me", "/v1/keys/prekeys"]) {
      expect((await call(path, { headers: bearer(lost.session.token) })).status).toBe(401);
    }
    const reRegister = await register(lost.session.token, deviceKeys(identityKey));
    expect(reRegister.status).toBe(401);
    expect((await call("/v1/me", { headers: bearer(other.session.token) })).status).toBe(200);
    expect(await count("sessions")).toBe(1);
  });

  // api #81: the chat service must stop other phones sealing to a removed (lost) device.
  it("sends device.removed to the chat service, only when the device existed", async () => {
    const a = await signIn();
    await register(a.session.token, deviceKeys());
    const other = await signIn();
    expect((await call("/v1/devices/2", { method: "DELETE", headers: bearer(other.session.token) })).status).toBe(404);
    expect(await outboxEvents()).toEqual([]);
    expect((await call("/v1/devices/1", { method: "DELETE", headers: bearer(other.session.token) })).status).toBe(204);
    const events = await outboxEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ v: 1, type: "device.removed", accountId: a.parent.id, deviceId: 1, sent: true });
  });

  it("logout-all?removeDevices=true removes every device of the parent and sends device.removed for each", async () => {
    const identityKey = ec();
    const lost = await signIn();
    await register(lost.session.token, deviceKeys(identityKey));
    const other = await signIn();
    await register(other.session.token, deviceKeys(identityKey));
    const stranger = await signIn("parent-s");
    await register(stranger.session.token, deviceKeys());
    const res = await call("/v1/auth/logout-all?removeDevices=true", {
      method: "POST",
      headers: bearer(other.session.token),
    });
    expect(res.status).toBe(204);
    expect(await count("devices")).toBe(1);
    expect(await count("one_time_prekeys")).toBe(3);
    expect((await call("/v1/me", { headers: bearer(lost.session.token) })).status).toBe(401);
    expect((await call("/v1/me", { headers: bearer(stranger.session.token) })).status).toBe(200);
    const events = await outboxEvents();
    expect(events.map((e) => [e.type, e.deviceId])).toEqual([
      ["device.removed", 1],
      ["device.removed", 2],
      ["account.sessions_revoked", undefined],
    ]);
    expect(events.every((e) => e.accountId === lost.parent.id && e.sent)).toBe(true);
    // The identity stays: the phones register again with the same keys at their next sign-in.
    const again = await signIn();
    expect((await register(again.session.token, deviceKeys(identityKey))).status).toBe(201);
  });

  it("logout-all without removeDevices keeps the devices", async () => {
    const a = await signIn();
    await register(a.session.token, deviceKeys());
    expect((await call("/v1/auth/logout-all", { method: "POST", headers: bearer(a.session.token) })).status).toBe(204);
    expect(await count("devices")).toBe(1);
    expect((await outboxEvents()).map((e) => e.type)).toEqual(["account.sessions_revoked"]);
  });

  it("removing the caller's own device signs the caller out", async () => {
    const a = await signIn();
    await register(a.session.token, deviceKeys());
    await call("/v1/devices/1", { method: "DELETE", headers: bearer(a.session.token) });
    expect((await call("/v1/me", { headers: bearer(a.session.token) })).status).toBe(401);
  });

  it("the identity stays when the last device goes", async () => {
    const a = await signIn();
    await register(a.session.token, deviceKeys());
    await call("/v1/devices/1", { method: "DELETE", headers: bearer(a.session.token) });
    const again = await signIn(); // removing the own device signed this session out
    expect((await call(`/v1/accounts/${a.parent.id}/identity`, { headers: bearer(again.session.token) })).status).toBe(
      200,
    );
  });

  it("only own devices: another account's device 1 → 404 and stays", async () => {
    const a = await signIn("parent-a");
    await register(a.session.token, deviceKeys());
    const b = await signIn("parent-b");
    await expectError(
      await call("/v1/devices/1", { method: "DELETE", headers: bearer(b.session.token) }),
      404,
      "not_found",
    );
    expect(await count("devices")).toBe(1);
  });

  it("not a device id → 404", async () => {
    const a = await signIn();
    for (const id of ["0", "128", "abc", "1.5"]) {
      expect((await call(`/v1/devices/${id}`, { method: "DELETE", headers: bearer(a.session.token) })).status).toBe(
        404,
      );
    }
  });

  it("without a session → 401", async () => {
    expect((await call("/v1/devices/1", { method: "DELETE" })).status).toBe(401);
  });
});

describe("activity and expiry", () => {
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

  it("a request on a device's session marks it active (at most daily)", async () => {
    const a = await signIn();
    await register(a.session.token, deviceKeys());
    await env.DB.prepare("UPDATE devices SET last_seen_at = ?").bind(daysAgo(5)).run();
    await call("/v1/me", { headers: bearer(a.session.token) });
    const seen = await env.DB.prepare("SELECT last_seen_at FROM devices").first<string>("last_seen_at");
    expect(Date.parse(seen ?? "")).toBeGreaterThan(Date.now() - 60_000);
  });

  it("the daily cron removes devices inactive for 90 days, with their keys", async () => {
    const identityKey = ec();
    const a = await signIn();
    await register(a.session.token, deviceKeys(identityKey));
    const b = await signIn();
    await register(b.session.token, deviceKeys(identityKey));
    await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE device_id = 1").bind(daysAgo(91)).run();
    await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE device_id = 2").bind(daysAgo(10)).run();
    await worker.scheduled(createScheduledController({ cron: "17 * * * *" }), env);
    const ids = await env.DB.prepare("SELECT device_id FROM devices").all<{ device_id: number }>();
    expect(ids.results.map((r) => r.device_id)).toEqual([2]);
    expect(await count("one_time_prekeys")).toBe(3);
    // H2: the expired device's session is signed out, not just unbound.
    expect((await call("/v1/me", { headers: bearer(a.session.token) })).status).toBe(401);
    expect((await call("/v1/me", { headers: bearer(b.session.token) })).status).toBe(200);
  });
});
