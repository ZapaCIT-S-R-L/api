// Apple App Attest (iOS): register a key once (challenge → attestation), then every sign-in carries an assertion
// over SHA-256 of its exact body in `ZapaKid-Attestation: v1 keyId=<base64> assertion=<base64>`. The tests replace
// Apple's root CA with a generated one (setAppAttestRootForTests); production code only knows Apple's.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { resetAppAttestRoot, setAppAttestRootForTests } from "../../src/app-attest";
import { b64, fakeApple, FakeDevice, type FakeApple } from "./app-attest-fixtures";
import {
  ADULT,
  ADULT_GOOGLE,
  appleClaims,
  count,
  googleClaims,
  makeIssuer,
  pendingNonce,
  primeNonce,
  resetJwksCache,
  sha256Hex,
  stubJwks,
  workerRequest,
  type ErrorBody,
  type TestIssuer,
} from "./helpers";

let apple: FakeApple;
let device: FakeDevice;
let appleIdp: TestIssuer;
let googleIdp: TestIssuer;

beforeEach(async () => {
  resetJwksCache();
  apple = await fakeApple();
  setAppAttestRootForTests(apple.rootDer);
  device = await FakeDevice.create(apple);
  appleIdp = await makeIssuer();
  googleIdp = await makeIssuer();
  stubJwks([appleIdp], [googleIdp]);
});

afterEach(() => {
  resetAppAttestRoot();
  vi.restoreAllMocks();
});

const REQUIRED = { ATTESTATION_POLICY: "required" };

function send(
  path: string,
  body: string,
  headers: Record<string, string> = {},
  overrides: Record<string, unknown> = REQUIRED,
) {
  const request = workerRequest(`https://api.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `10.8.${Math.floor(Math.random() * 255)}.1`,
      ...headers,
    },
    body,
  });
  return worker.fetch(request, { ...env, ...overrides });
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect((await res.json<ErrorBody>()).error.code).toBe(code);
}

async function challenge(): Promise<string> {
  const res = await send("/v1/attestation/challenge", "");
  expect(res.status).toBe(200);
  return (await res.json<{ challenge: string }>()).challenge;
}

async function register(d: FakeDevice = device, options: Parameters<FakeDevice["attest"]>[1] = {}, keyId = d.keyId) {
  const c = await challenge();
  const attestationObject = await d.attest(c, options);
  return send("/v1/attestation/apple", JSON.stringify({ keyId, attestationObject, challenge: c }));
}

// A native Apple sign-in body for the pending nonce.
async function appleSignInBody(): Promise<string> {
  return JSON.stringify({
    identityToken: await appleIdp.sign(appleClaims()),
    ageRange: ADULT,
    nonce: pendingNonce()?.nonce,
  });
}

describe("POST /v1/attestation/challenge", () => {
  it("a 43-character one-time challenge for 5 minutes, stored only as a hash", async () => {
    const before = Date.now();
    const res = await send("/v1/attestation/challenge", "");
    const body = await res.json<{ challenge: string; expiresAt: string }>();
    expect(body.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(body.expiresAt)).toBeGreaterThanOrEqual(before + 300_000 - 1000);
    const rows = await env.DB.prepare("SELECT * FROM app_attest_challenges").all();
    expect(JSON.stringify(rows.results)).not.toContain(body.challenge);
    expect(JSON.stringify(rows.results)).toContain(await sha256Hex(body.challenge));
  });
});

describe("POST /v1/attestation/apple", () => {
  it("a genuine attestation → 204, the key is stored with counter 0", async () => {
    expect((await register()).status).toBe(204);
    const row = await env.DB.prepare("SELECT key_id, counter, environment FROM app_attest_keys").first();
    expect(row).toEqual({ key_id: device.keyId, counter: 0, environment: "development" });
  });

  it("a production key (TestFlight, App Store) → 204", async () => {
    expect((await register(device, { aaguid: "appattest" })).status).toBe(204);
  });

  it("a development key where only production is allowed → 403", async () => {
    const res = await register(device, {}, device.keyId);
    expect(res.status).toBe(204);
    const other = await FakeDevice.create(apple);
    const c = await challenge();
    const res2 = await send(
      "/v1/attestation/apple",
      JSON.stringify({ keyId: other.keyId, attestationObject: await other.attest(c), challenge: c }),
      {},
      { ...REQUIRED, APP_ATTEST_ENVIRONMENTS: "production" },
    );
    await expectError(res2, 403, "attestation_failed");
  });

  it("the challenge is used up, even when the attestation is refused", async () => {
    const c = await challenge();
    const good = await device.attest(c);
    const bad = await device.attest(c, { appId: "9572LYGZ7S.com.example" });
    await expectError(
      await send(
        "/v1/attestation/apple",
        JSON.stringify({ keyId: device.keyId, attestationObject: bad, challenge: c }),
      ),
      403,
      "attestation_failed",
    );
    await expectError(
      await send(
        "/v1/attestation/apple",
        JSON.stringify({ keyId: device.keyId, attestationObject: good, challenge: c }),
      ),
      403,
      "attestation_failed",
    );
  });

  it("a challenge the server never issued → 403", async () => {
    const c = "Q".repeat(43);
    const res = await send(
      "/v1/attestation/apple",
      JSON.stringify({ keyId: device.keyId, attestationObject: await device.attest(c), challenge: c }),
    );
    await expectError(res, 403, "attestation_failed");
  });

  it("an expired challenge → 403", async () => {
    const c = await challenge();
    await env.DB.prepare("UPDATE app_attest_challenges SET expires_at = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    const res = await send(
      "/v1/attestation/apple",
      JSON.stringify({ keyId: device.keyId, attestationObject: await device.attest(c), challenge: c }),
    );
    await expectError(res, 403, "attestation_failed");
  });

  const refused: [string, Parameters<FakeDevice["attest"]>[1]][] = [
    ["another app (RP ID hash)", { appId: "9572LYGZ7S.com.example.other" }],
    ["another team", { appId: "AAAAAAAAAA.ro.zapakid.app" }],
    ["counter not 0", { counter: 1 }],
    ["wrong nonce in the certificate", { nonce: new Uint8Array(32) }],
    ["credential id isn't the key id", { credentialId: new Uint8Array(32).fill(7) }],
    ["not the apple-appattest format", { fmt: "packed" }],
    ["expired leaf certificate", { expired: true }],
  ];
  for (const [why, options] of refused) {
    it(`${why} → 403 attestation_failed`, async () => {
      await expectError(await register(device, options), 403, "attestation_failed");
      expect(await count("app_attest_keys")).toBe(0);
    });
  }

  it("a chain to another root (not Apple's) → 403", async () => {
    const otherApple = await fakeApple();
    await expectError(await register(device, { issuer: otherApple }), 403, "attestation_failed");
  });

  it("a key id that isn't the certificate's key → 403", async () => {
    const other = await FakeDevice.create(apple);
    await expectError(await register(device, {}, other.keyId), 403, "attestation_failed");
  });

  it("garbage instead of an attestation object → 403", async () => {
    const c = await challenge();
    const res = await send(
      "/v1/attestation/apple",
      JSON.stringify({ keyId: device.keyId, attestationObject: b64(new Uint8Array([1, 2, 3])), challenge: c }),
    );
    await expectError(res, 403, "attestation_failed");
  });

  it("the same key twice → the second is refused", async () => {
    expect((await register()).status).toBe(204);
    await expectError(await register(), 403, "attestation_failed");
  });

  it("bad body → 400", async () => {
    await expectError(await send("/v1/attestation/apple", JSON.stringify({ keyId: "x" })), 400, "invalid_request");
  });
});

describe("sign-in with an App Attest assertion", () => {
  beforeEach(async () => {
    expect((await register()).status).toBe(204);
  });

  it("native Apple sign-in → 200", async () => {
    const body = await appleSignInBody();
    expect((await send("/v1/auth/apple", body, { "zapakid-attestation": await device.assert(body) })).status).toBe(200);
  });

  it("Google sign-in on iOS → 200", async () => {
    const body = JSON.stringify({
      idToken: await googleIdp.sign(googleClaims()),
      ageRange: ADULT_GOOGLE,
      nonce: pendingNonce()?.nonce,
    });
    expect((await send("/v1/auth/google", body, { "zapakid-attestation": await device.assert(body) })).status).toBe(
      200,
    );
  });

  it("the counter is stored", async () => {
    const body = await appleSignInBody();
    await send("/v1/auth/apple", body, { "zapakid-attestation": await device.assert(body, { counter: 5 }) });
    expect(await env.DB.prepare("SELECT counter FROM app_attest_keys").first("counter")).toBe(5);
  });

  it("an assertion for another body → 403, nonce still usable", async () => {
    const body = await appleSignInBody();
    await expectError(
      await send("/v1/auth/apple", body, { "zapakid-attestation": await device.assert(`${body} `) }),
      403,
      "attestation_failed",
    );
    expect(await count("sign_in_nonces")).toBe(1);
  });

  it("a replayed assertion (same counter) → 403", async () => {
    const body = await appleSignInBody();
    const header = await device.assert(body);
    expect((await send("/v1/auth/apple", body, { "zapakid-attestation": header })).status).toBe(200);
    await primeNonce();
    await expectError(await send("/v1/auth/apple", body, { "zapakid-attestation": header }), 403, "attestation_failed");
  });

  it("a lower counter → 403", async () => {
    const first = await appleSignInBody();
    await send("/v1/auth/apple", first, { "zapakid-attestation": await device.assert(first, { counter: 10 }) });
    await primeNonce();
    const second = await appleSignInBody();
    await expectError(
      await send("/v1/auth/apple", second, { "zapakid-attestation": await device.assert(second, { counter: 9 }) }),
      403,
      "attestation_failed",
    );
  });

  it("signed by another key → 403", async () => {
    const body = await appleSignInBody();
    const other = await FakeDevice.create(apple);
    const header = await device.assert(body, { key: other.keys.privateKey });
    await expectError(await send("/v1/auth/apple", body, { "zapakid-attestation": header }), 403, "attestation_failed");
  });

  it("another app's RP ID hash → 403", async () => {
    const body = await appleSignInBody();
    await expectError(
      await send("/v1/auth/apple", body, {
        "zapakid-attestation": await device.assert(body, { appId: "9572LYGZ7S.com.example" }),
      }),
      403,
      "attestation_failed",
    );
  });

  it("an unregistered key → 403", async () => {
    const body = await appleSignInBody();
    const stranger = await FakeDevice.create(apple);
    await expectError(
      await send("/v1/auth/apple", body, { "zapakid-attestation": await stranger.assert(body) }),
      403,
      "attestation_failed",
    );
  });

  const malformed = [
    "v1",
    "v1 keyId=abc assertion=def",
    "v2 keyId=x assertion=y",
    `v1 assertion=AAAA keyId=${"A".repeat(43)}=`,
  ];
  for (const header of malformed) {
    it(`malformed header "${header.slice(0, 24)}" → 403`, async () => {
      await expectError(
        await send("/v1/auth/apple", await appleSignInBody(), { "zapakid-attestation": header }),
        403,
        "attestation_failed",
      );
    });
  }

  it("allowlist policy (staging): a valid assertion works for anyone, a bad one is refused", async () => {
    const policy = { ATTESTATION_POLICY: "allowlist" };
    const body = await appleSignInBody();
    expect(
      (await send("/v1/auth/apple", body, { "zapakid-attestation": await device.assert(body) }, policy)).status,
    ).toBe(200);
    await primeNonce();
    const next = await appleSignInBody();
    await expectError(
      await send("/v1/auth/apple", next, { "zapakid-attestation": await device.assert("other") }, policy),
      403,
      "attestation_failed",
    );
  });
});

describe("purge", () => {
  it("deletes expired challenges", async () => {
    await challenge();
    await env.DB.prepare("UPDATE app_attest_challenges SET expires_at = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    await worker.scheduled(
      { cron: "17 3 * * *", scheduledTime: Date.now(), noRetry: () => undefined } as ScheduledController,
      env,
    );
    expect(await count("app_attest_challenges")).toBe(0);
  });
});
