// PUT /v1/keys/identity: replacing the account identity key. Never silent (history + endorsement for peers), gated
// by session + attestation + a fresh sign-in, and it removes every old device, prekey and other session.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
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

function keys(identityKey: string, extra: Record<string, unknown> = {}) {
  return {
    registrationId: 77,
    identityKey,
    signedPreKey: { keyId: 1, publicKey: ec(), signature: sig() },
    pqLastResortPreKey: { keyId: 1, publicKey: kyber(), signature: sig() },
    preKeys: [10, 11].map((keyId) => ({ keyId, publicKey: ec() })),
    pqPreKeys: [2].map((keyId) => ({ keyId, publicKey: kyber(), signature: sig() })),
    ...extra,
  };
}

async function signIn(sub = "parent-1"): Promise<SignInBody> {
  const res = await postJson("/v1/auth/apple", {
    identityToken: await apple.sign(appleClaims({ sub })),
    ageRange: ADULT,
  });
  return res.json<SignInBody>();
}

const send = (method: string, path: string, token: string, body: unknown) =>
  call(path, {
    method,
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify(body),
  });

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect((await res.json<ErrorBody>()).error.code).toBe(code);
}

// A parent with two registered phones on the old identity.
async function setup() {
  const oldKey = ec();
  const phoneA = await signIn();
  await send("POST", "/v1/devices", phoneA.session.token, keys(oldKey));
  const phoneB = await signIn();
  await send("POST", "/v1/devices", phoneB.session.token, keys(oldKey));
  const newPhone = await signIn();
  return { oldKey, phoneA, phoneB, newPhone, accountId: newPhone.parent.id };
}

describe("PUT /v1/keys/identity", () => {
  it("replaces the identity, removes the old devices and other sessions, binds this phone as the only device", async () => {
    const { oldKey, phoneA, phoneB, newPhone, accountId } = await setup();
    const newKey = ec();
    const endorsement = sig();
    const res = await send("PUT", "/v1/keys/identity", newPhone.session.token, keys(newKey, { endorsement }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deviceId: 1 });

    for (const token of [phoneA.session.token, phoneB.session.token]) {
      expect((await call("/v1/me", { headers: bearer(token) })).status).toBe(401);
    }
    expect(await count("devices")).toBe(1);
    expect(await count("one_time_prekeys")).toBe(2);
    expect(await count("sessions")).toBe(1);
    expect(await (await call("/v1/keys/prekeys", { headers: bearer(newPhone.session.token) })).json()).toEqual({
      preKeys: 2,
      pqPreKeys: 1,
    });

    const identity = await call(`/v1/accounts/${accountId}/identity`, { headers: bearer(newPhone.session.token) });
    const body = await identity.json<{ identityKey: string; changes: Record<string, unknown>[] }>();
    expect(body.identityKey).toBe(newKey);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toMatchObject({ identityKey: newKey, previousIdentityKey: oldKey, endorsement });
    expect(Date.parse(String(body.changes[0]?.changedAt))).toBeGreaterThan(Date.now() - 60_000);
  });

  it("without an endorsement (old key lost) it still changes, recorded with endorsement null", async () => {
    const { newPhone, accountId } = await setup();
    expect((await send("PUT", "/v1/keys/identity", newPhone.session.token, keys(ec()))).status).toBe(200);
    const identity = await call(`/v1/accounts/${accountId}/identity`, { headers: bearer(newPhone.session.token) });
    expect((await identity.json<{ changes: { endorsement: unknown }[] }>()).changes[0]?.endorsement).toBeNull();
  });

  // The server stores the endorsement for peers and doesn't (can't) check it: see README "Security notes".
  it("accepts an all-zero endorsement: peers verify it with libsignal, not the server", async () => {
    const { newPhone } = await setup();
    const res = await send(
      "PUT",
      "/v1/keys/identity",
      newPhone.session.token,
      keys(ec(), { endorsement: b64(new Uint8Array(64)) }),
    );
    expect(res.status).toBe(200);
  });

  it("each change adds to the history, oldest first", async () => {
    const { oldKey, newPhone, accountId } = await setup();
    const k1 = ec();
    const k2 = ec();
    await send("PUT", "/v1/keys/identity", newPhone.session.token, keys(k1));
    await send("PUT", "/v1/keys/identity", newPhone.session.token, keys(k2));
    const identity = await call(`/v1/accounts/${accountId}/identity`, { headers: bearer(newPhone.session.token) });
    const { changes } = await identity.json<{ changes: { identityKey: string; previousIdentityKey: string }[] }>();
    expect(changes.map((c) => [c.previousIdentityKey, c.identityKey])).toEqual([
      [oldKey, k1],
      [k1, k2],
    ]);
  });

  it("a session older than 10 minutes → 403 reauthentication_required, nothing changes", async () => {
    const { oldKey, newPhone, accountId } = await setup();
    await env.DB.prepare("UPDATE sessions SET created_at = ? WHERE parent_id = ?")
      .bind(new Date(Date.now() - 11 * 60_000).toISOString(), accountId)
      .run();
    await expectError(
      await send("PUT", "/v1/keys/identity", newPhone.session.token, keys(ec())),
      403,
      "reauthentication_required",
    );
    const identity = await env.DB.prepare("SELECT identity_key FROM account_identities").first("identity_key");
    expect(identity).toBe(oldKey);
    expect(await count("devices")).toBe(2);
  });

  it("the same key as now → 409 identity_unchanged", async () => {
    const { oldKey, newPhone } = await setup();
    await expectError(
      await send("PUT", "/v1/keys/identity", newPhone.session.token, keys(oldKey)),
      409,
      "identity_unchanged",
    );
  });

  it("no identity yet → 409 no_identity (register with POST /v1/devices)", async () => {
    const a = await signIn();
    await expectError(await send("PUT", "/v1/keys/identity", a.session.token, keys(ec())), 409, "no_identity");
  });

  it("an endorsement that isn't 64 bytes → 400 invalid_keys", async () => {
    const { newPhone } = await setup();
    const res = await send(
      "PUT",
      "/v1/keys/identity",
      newPhone.session.token,
      keys(ec(), { endorsement: b64(new Uint8Array(32)) }),
    );
    await expectError(res, 400, "invalid_keys");
  });

  it("bad keys → 400 invalid_keys, nothing changes", async () => {
    const { newPhone } = await setup();
    await expectError(
      await send("PUT", "/v1/keys/identity", newPhone.session.token, keys(b64(typed(0x05, 20)))),
      400,
      "invalid_keys",
    );
    expect(await count("devices")).toBe(2);
  });

  it("without a session → 401; after logout → 401", async () => {
    const { newPhone } = await setup();
    expect(
      (await call("/v1/keys/identity", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }))
        .status,
    ).toBe(401);
    await call("/v1/auth/logout", { method: "POST", headers: bearer(newPhone.session.token) });
    expect((await send("PUT", "/v1/keys/identity", newPhone.session.token, keys(ec()))).status).toBe(401);
    expect(await count("devices")).toBe(2);
  });

  it("with the required attestation policy, no header → 403 and nothing changes", async () => {
    const { newPhone } = await setup();
    const request = workerRequest("https://api.test/v1/keys/identity", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...bearer(newPhone.session.token),
        "cf-connecting-ip": "10.6.6.6",
      },
      body: JSON.stringify(keys(ec())),
    });
    await expectError(
      await worker.fetch(request, { ...env, ATTESTATION_POLICY: "required" }),
      403,
      "attestation_failed",
    );
    expect(await count("devices")).toBe(2);
  });
});
