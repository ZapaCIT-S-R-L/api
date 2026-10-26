// Sign-in nonces: POST /v1/auth/nonce issues a one-time nonce; the Apple/Google token must carry its SHA-256
// (hex) in the `nonce` claim; each nonce works once and expires after 10 minutes. Replays are rejected.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADULT,
  ADULT_GOOGLE,
  appleClaims,
  call,
  count,
  googleClaims,
  makeIssuer,
  primeNonce,
  resetJwksCache,
  sha256Hex,
  stubJwks,
  type ErrorBody,
  type TestIssuer,
} from "./helpers";

let apple: TestIssuer;
let google: TestIssuer;

beforeEach(async () => {
  resetJwksCache();
  apple = await makeIssuer();
  google = await makeIssuer();
  stubJwks([apple], [google]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Posts exactly this body (no automatic nonce).
const post = (path: string, body: unknown) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect((await res.json<ErrorBody>()).error.code).toBe(code);
}

describe("POST /v1/auth/nonce", () => {
  it("issues a 43-character base64url nonce valid for 10 minutes", async () => {
    const before = Date.now();
    const res = await call("/v1/auth/nonce", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json<{ nonce: string; expiresAt: string }>();
    expect(body.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expires = Date.parse(body.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(before + 600_000 - 1000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 600_000 + 1000);
  });

  it("stores only the nonce's hash", async () => {
    const { nonce, hash } = await primeNonce();
    const rows = await env.DB.prepare("SELECT * FROM sign_in_nonces").all();
    expect(JSON.stringify(rows.results)).not.toContain(nonce);
    expect(JSON.stringify(rows.results)).toContain(await sha256Hex(hash));
  });

  it("every nonce is different", async () => {
    const a = await primeNonce();
    const b = await primeNonce();
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("GET → 405", async () => {
    expect((await call("/v1/auth/nonce")).status).toBe(405);
  });
});

describe("sign-in requires the nonce", () => {
  it("Apple: the right nonce → 200, and the nonce is used up", async () => {
    const { nonce, hash } = await primeNonce();
    const token = await apple.sign(appleClaims({ nonce: hash }));
    expect((await post("/v1/auth/apple", { identityToken: token, ageRange: ADULT, nonce })).status).toBe(200);
    const rows = await env.DB.prepare("SELECT * FROM sign_in_nonces WHERE nonce_hash = ?")
      .bind(await sha256Hex(hash))
      .all();
    expect(rows.results).toHaveLength(0);
  });

  it("Google: the right nonce → 200", async () => {
    const { nonce, hash } = await primeNonce();
    const token = await google.sign(googleClaims({ nonce: hash }));
    expect((await post("/v1/auth/google", { idToken: token, ageRange: ADULT_GOOGLE, nonce })).status).toBe(200);
  });

  it("replaying the same token and nonce → 401 invalid_nonce, one session only", async () => {
    const { nonce, hash } = await primeNonce();
    const token = await apple.sign(appleClaims({ nonce: hash }));
    expect((await post("/v1/auth/apple", { identityToken: token, ageRange: ADULT, nonce })).status).toBe(200);
    await expectError(
      await post("/v1/auth/apple", { identityToken: token, ageRange: ADULT, nonce }),
      401,
      "invalid_nonce",
    );
    expect(await count("sessions")).toBe(1);
  });

  it("a token without a nonce claim → 401 invalid_nonce", async () => {
    const { nonce } = await primeNonce();
    const token = await apple.sign(appleClaims({ nonce: undefined }));
    await expectError(
      await post("/v1/auth/apple", { identityToken: token, ageRange: ADULT, nonce }),
      401,
      "invalid_nonce",
    );
  });

  it("the raw nonce in the token instead of its hash → 401 invalid_nonce", async () => {
    const { nonce } = await primeNonce();
    const token = await apple.sign(appleClaims({ nonce }));
    await expectError(
      await post("/v1/auth/apple", { identityToken: token, ageRange: ADULT, nonce }),
      401,
      "invalid_nonce",
    );
  });

  it("a token for another nonce → 401 invalid_nonce, and neither nonce is used up", async () => {
    const first = await primeNonce();
    const second = await primeNonce();
    const token = await apple.sign(appleClaims({ nonce: first.hash }));
    await expectError(
      await post("/v1/auth/apple", { identityToken: token, ageRange: ADULT, nonce: second.nonce }),
      401,
      "invalid_nonce",
    );
    expect(await count("sign_in_nonces")).toBe(3);
  });

  it("a nonce the server never issued → 401 invalid_nonce", async () => {
    const nonce = "A".repeat(43);
    const token = await apple.sign(appleClaims({ nonce: await sha256Hex(nonce) }));
    await expectError(
      await post("/v1/auth/apple", { identityToken: token, ageRange: ADULT, nonce }),
      401,
      "invalid_nonce",
    );
  });

  it("an expired nonce → 401 invalid_nonce", async () => {
    const { nonce, hash } = await primeNonce();
    await env.DB.prepare("UPDATE sign_in_nonces SET expires_at = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    const token = await apple.sign(appleClaims({ nonce: hash }));
    await expectError(
      await post("/v1/auth/apple", { identityToken: token, ageRange: ADULT, nonce }),
      401,
      "invalid_nonce",
    );
  });

  it("a bad token doesn't use up the nonce", async () => {
    const { nonce, hash } = await primeNonce();
    const forged = await (await makeIssuer(apple.kid)).sign(appleClaims({ nonce: hash }));
    await expectError(
      await post("/v1/auth/apple", { identityToken: forged, ageRange: ADULT, nonce }),
      401,
      "invalid_token",
    );
    const token = await apple.sign(appleClaims({ nonce: hash }));
    expect((await post("/v1/auth/apple", { identityToken: token, ageRange: ADULT, nonce })).status).toBe(200);
  });

  it("a minor uses up the nonce (no retry with a different age range)", async () => {
    const { nonce, hash } = await primeNonce();
    const token = await apple.sign(appleClaims({ nonce: hash }));
    const minor = { ...ADULT, lowerBound: null, upperBound: 12 };
    await expectError(
      await post("/v1/auth/apple", { identityToken: token, ageRange: minor, nonce }),
      403,
      "minor_not_allowed",
    );
    await expectError(
      await post("/v1/auth/apple", { identityToken: token, ageRange: ADULT, nonce }),
      401,
      "invalid_nonce",
    );
  });

  it("a nonce that isn't 43 base64url characters → 400", async () => {
    const token = await apple.sign(appleClaims());
    await expectError(
      await post("/v1/auth/apple", { identityToken: token, ageRange: ADULT, nonce: "short" }),
      400,
      "invalid_request",
    );
  });
});
