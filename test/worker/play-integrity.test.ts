// Play Integrity on sign-in (Android): a standard integrity token in ZapaKid-Attestation whose requestHash is the
// SHA-256 (hex) of the exact body. The server decodes it with Google's API, keyless: it signs a short assertion with
// its own key (CHAT_TOKEN_SIGNING_KEY, published at /.well-known/jwks.json), Google's STS trusts that issuer through
// Workload Identity Federation, and the federated token impersonates the service account. Google's endpoints are
// served by the test.
import { env } from "cloudflare:workers";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import {
  call,
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
  signInParent,
  stubJwks,
  type ErrorBody,
  type JwksStub,
  type TestIssuer,
  workerRequest,
} from "./helpers";
import { resetPlayIntegrityCache } from "../../src/play-integrity";

const PACKAGE = "ro.zapakid.app";
const CERT = "xYzSigningCertDigestBase64UrlNoPadding0123456";
const SA_EMAIL = "play-integrity@zapakid-test.iam.gserviceaccount.com";
const WIF_AUDIENCE =
  "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/cloudflare/providers/api-test";
const STS_URL = "https://sts.googleapis.com/v1/token";
const IMPERSONATE_URL = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA_EMAIL}:generateAccessToken`;
const DECODE_URL = `https://playintegrity.googleapis.com/v1/${PACKAGE}:decodeIntegrityToken`;

let google: TestIssuer;
let apple: TestIssuer;
let jwks: JwksStub;
let issuerKeys: JSONWebKeySet;
let verdicts: Map<string, unknown>;
let tokenCalls: number;
let decodeStatus: number;

beforeEach(async () => {
  resetJwksCache();
  resetPlayIntegrityCache();
  google = await makeIssuer();
  apple = await makeIssuer();
  jwks = stubJwks([apple], [google]);
  issuerKeys = await (await worker.fetch(workerRequest("https://api.test/.well-known/jwks.json"), env)).json();
  verdicts = new Map();
  tokenCalls = 0;
  decodeStatus = 200;
  jwks.other = (url, init) => {
    if (url === STS_URL) return sts(init);
    if (url === IMPERSONATE_URL) return impersonate(init);
    if (url === DECODE_URL) return decode(init);
    return undefined;
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Google's STS: trades an assertion from the API's own issuer (its published JWKS, the provider's audience,
// subject "play-integrity") for a federated token.
async function sts(init: RequestInit | undefined): Promise<Response> {
  tokenCalls++;
  const form = new URLSearchParams(init?.body as string);
  if (
    form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:token-exchange" ||
    form.get("audience") !== WIF_AUDIENCE ||
    form.get("subject_token_type") !== "urn:ietf:params:oauth:token-type:jwt" ||
    form.get("requested_token_type") !== "urn:ietf:params:oauth:token-type:access_token"
  )
    return new Response("invalid_request", { status: 400 });
  try {
    const { payload } = await jwtVerify(form.get("subject_token") ?? "", createLocalJWKSet(issuerKeys), {
      issuer: env.CHAT_TOKEN_ISSUER,
      audience: `https:${WIF_AUDIENCE}`,
      subject: "play-integrity",
      maxTokenAge: "10m",
    });
    if (!payload.exp || payload.exp - Date.now() / 1000 > 600) throw new Error("lives too long");
  } catch {
    return new Response("invalid_grant", { status: 400 });
  }
  return Response.json({ access_token: "federated-token", token_type: "Bearer", expires_in: 3600 });
}

// IAM Credentials: the federated principal may impersonate the service account, for the Play Integrity scope only.
function impersonate(init: RequestInit | undefined): Response {
  if (new Headers(init?.headers).get("authorization") !== "Bearer federated-token")
    return new Response("unauthenticated", { status: 401 });
  const { scope } = JSON.parse(init?.body as string) as { scope: string[] };
  if (scope.join() !== "https://www.googleapis.com/auth/playintegrity")
    return new Response("bad scope", { status: 400 });
  const expireTime = new Date(Date.now() + 3600_000).toISOString();
  return Response.json({ accessToken: "ya29.test-access-token", expireTime });
}

// Google's decodeIntegrityToken: the verdict the test registered for this token.
function decode(init: RequestInit | undefined): Promise<Response> {
  if (decodeStatus !== 200) return Promise.resolve(new Response("error", { status: decodeStatus }));
  const auth = new Headers(init?.headers).get("authorization");
  if (auth !== "Bearer ya29.test-access-token")
    return Promise.resolve(new Response("unauthenticated", { status: 401 }));
  const { integrity_token } = JSON.parse(init?.body as string) as { integrity_token: string };
  const payload = verdicts.get(integrity_token);
  if (!payload) return Promise.resolve(new Response(JSON.stringify({ error: { code: 400 } }), { status: 400 }));
  return Promise.resolve(Response.json({ tokenPayloadExternal: payload }));
}

function verdict(requestHash: string, overrides: Record<string, unknown> = {}) {
  return {
    requestDetails: { requestPackageName: PACKAGE, requestHash, timestampMillis: String(Date.now()) },
    appIntegrity: {
      appRecognitionVerdict: "PLAY_RECOGNIZED",
      packageName: PACKAGE,
      certificateSha256Digest: [CERT],
      versionCode: "7",
    },
    deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
    accountDetails: { appLicensingVerdict: "LICENSED" },
    ...overrides,
  };
}

const REQUIRED = () => ({
  ATTESTATION_POLICY: "required",
  PLAY_INTEGRITY_WIF_AUDIENCE: WIF_AUDIENCE,
  PLAY_INTEGRITY_SERVICE_ACCOUNT: SA_EMAIL,
  PLAY_CERT_SHA256: CERT,
});

async function send(path: string, body: string, headers: Record<string, string>, overrides: Record<string, unknown>) {
  const request = workerRequest(`https://api.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `10.9.${Math.floor(Math.random() * 255)}.1`,
      ...headers,
    },
    body,
  });
  return worker.fetch(request, { ...env, ...overrides });
}

// A Google sign-in body for the pending nonce, and a Play Integrity token bound to exactly that body.
async function googleSignIn(verdictOverrides: Record<string, unknown> = {}, hashOf?: string) {
  const nonce = pendingNonce();
  if (!nonce) throw new Error("no nonce");
  const body = JSON.stringify({
    idToken: await google.sign(googleClaims()),
    ageRange: ADULT_GOOGLE,
    nonce: nonce.nonce,
  });
  const token = `integrity-token-${Math.random().toString(36).slice(2)}`;
  verdicts.set(token, verdict(await sha256Hex(hashOf ?? body), verdictOverrides));
  return { body, token };
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect((await res.json<ErrorBody>()).error.code).toBe(code);
}

describe("policy required", () => {
  it("a genuine app on a genuine device → 200", async () => {
    const { body, token } = await googleSignIn();
    const res = await send("/v1/auth/google", body, { "zapakid-attestation": token }, REQUIRED());
    expect(res.status).toBe(200);
  });

  it("no header → 403 attestation_failed, and the nonce is still usable", async () => {
    const { body } = await googleSignIn();
    await expectError(await send("/v1/auth/google", body, {}, REQUIRED()), 403, "attestation_failed");
    expect(await count("sign_in_nonces")).toBe(1);
    expect(await count("sessions")).toBe(0);
  });

  const failing: [string, Record<string, unknown>][] = [
    [
      "not recognized by Play (sideloaded or modified)",
      {
        appIntegrity: {
          appRecognitionVerdict: "UNRECOGNIZED_VERSION",
          packageName: PACKAGE,
          certificateSha256Digest: [CERT],
        },
      },
    ],
    [
      "another package",
      {
        appIntegrity: {
          appRecognitionVerdict: "PLAY_RECOGNIZED",
          packageName: "com.evil",
          certificateSha256Digest: [CERT],
        },
      },
    ],
    [
      "another signing certificate",
      {
        appIntegrity: {
          appRecognitionVerdict: "PLAY_RECOGNIZED",
          packageName: PACKAGE,
          certificateSha256Digest: ["other"],
        },
      },
    ],
    [
      "basic integrity only (rooted or emulator)",
      { deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY"] } },
    ],
    ["no device verdict", { deviceIntegrity: {} }],
    ["not licensed", { accountDetails: { appLicensingVerdict: "UNLICENSED" } }],
    [
      "requested by another package",
      { requestDetails: { requestPackageName: "com.evil", requestHash: "", timestampMillis: String(Date.now()) } },
    ],
    [
      "11 minutes old",
      {
        requestDetails: {
          requestPackageName: PACKAGE,
          requestHash: "",
          timestampMillis: String(Date.now() - 11 * 60_000),
        },
      },
    ],
    [
      "from the future",
      {
        requestDetails: {
          requestPackageName: PACKAGE,
          requestHash: "",
          timestampMillis: String(Date.now() + 5 * 60_000),
        },
      },
    ],
  ];
  for (const [why, overrides] of failing) {
    it(`${why} → 403 attestation_failed`, async () => {
      const { body, token } = await googleSignIn();
      const v = verdicts.get(token) as { requestDetails: { requestHash: string } };
      const fixed = overrides.requestDetails
        ? { requestDetails: { ...overrides.requestDetails, requestHash: v.requestDetails.requestHash } }
        : {};
      verdicts.set(token, { ...v, ...overrides, ...fixed });
      await expectError(
        await send("/v1/auth/google", body, { "zapakid-attestation": token }, REQUIRED()),
        403,
        "attestation_failed",
      );
      expect(await count("sessions")).toBe(0);
    });
  }

  it("a token for another body (request hash) → 403", async () => {
    const { body, token } = await googleSignIn({}, "some other body");
    await expectError(
      await send("/v1/auth/google", body, { "zapakid-attestation": token }, REQUIRED()),
      403,
      "attestation_failed",
    );
  });

  it("a token Google can't decode → 403", async () => {
    const { body } = await googleSignIn();
    await expectError(
      await send("/v1/auth/google", body, { "zapakid-attestation": "forged" }, REQUIRED()),
      403,
      "attestation_failed",
    );
  });

  it("Google's API down → 503 attestation_unavailable", async () => {
    const { body, token } = await googleSignIn();
    decodeStatus = 500;
    await expectError(
      await send("/v1/auth/google", body, { "zapakid-attestation": token }, REQUIRED()),
      503,
      "attestation_unavailable",
    );
  });

  it("no service account configured → 503 attestation_unavailable", async () => {
    const { body, token } = await googleSignIn();
    const res = await send(
      "/v1/auth/google",
      body,
      { "zapakid-attestation": token },
      { ...REQUIRED(), PLAY_INTEGRITY_WIF_AUDIENCE: undefined },
    );
    await expectError(res, 503, "attestation_unavailable");
  });

  it("without the API's own signing key → 503 attestation_unavailable", async () => {
    const { body, token } = await googleSignIn();
    const res = await send(
      "/v1/auth/google",
      body,
      { "zapakid-attestation": token },
      { ...REQUIRED(), CHAT_TOKEN_SIGNING_KEY: undefined },
    );
    await expectError(res, 503, "attestation_unavailable");
  });

  it("Google refuses the federation (provider or binding missing) → 503 attestation_unavailable", async () => {
    const { body, token } = await googleSignIn();
    const res = await send(
      "/v1/auth/google",
      body,
      { "zapakid-attestation": token },
      { ...REQUIRED(), PLAY_INTEGRITY_WIF_AUDIENCE: WIF_AUDIENCE.replace("api-test", "other") },
    );
    await expectError(res, 503, "attestation_unavailable");
  });

  it("caches Google's access token between sign-ins", async () => {
    for (let i = 0; i < 2; i++) {
      const { body, token } = await googleSignIn();
      expect((await send("/v1/auth/google", body, { "zapakid-attestation": token }, REQUIRED())).status).toBe(200);
      await primeNonce();
    }
    expect(tokenCalls).toBe(1);
  });

  it("the Apple web flow exchange needs it too (checked before the code is used up)", async () => {
    const body = JSON.stringify({
      code: "C".repeat(43),
      codeVerifier: "v".repeat(43),
      nonce: "N".repeat(43),
      ageRange: ADULT,
    });
    await expectError(await send("/v1/auth/apple/exchange", body, {}, REQUIRED()), 403, "attestation_failed");
  });

  it("native Apple sign-in without attestation → 403 (App Attest comes next)", async () => {
    const body = JSON.stringify({
      identityToken: await apple.sign(appleClaims()),
      ageRange: ADULT,
      nonce: pendingNonce()?.nonce,
    });
    await expectError(await send("/v1/auth/apple", body, {}, REQUIRED()), 403, "attestation_failed");
  });

  it("the nonce endpoint needs no attestation", async () => {
    const res = await send("/v1/auth/nonce", "", {}, REQUIRED());
    expect(res.status).toBe(200);
  });
});

describe("policy optional (local development only)", () => {
  const OPTIONAL = () => ({ ...REQUIRED(), ATTESTATION_POLICY: "optional" });

  it("no header → allowed", async () => {
    const { body } = await googleSignIn();
    expect((await send("/v1/auth/google", body, {}, OPTIONAL())).status).toBe(200);
  });

  it("a failing token → still 403", async () => {
    const { body, token } = await googleSignIn({ deviceIntegrity: { deviceRecognitionVerdict: [] } });
    await expectError(
      await send("/v1/auth/google", body, { "zapakid-attestation": token }, OPTIONAL()),
      403,
      "attestation_failed",
    );
  });

  it("a header but no service account → 503 (can't check it, so don't accept it)", async () => {
    const { body, token } = await googleSignIn();
    const res = await send(
      "/v1/auth/google",
      body,
      { "zapakid-attestation": token },
      { ...OPTIONAL(), PLAY_INTEGRITY_WIF_AUDIENCE: undefined },
    );
    await expectError(res, 503, "attestation_unavailable");
  });
});

// Staging: a missing header is let through only for allowlisted test accounts (ATTESTATION_ALLOWLIST secret,
// "provider:subject" entries), e.g. a debug build that Play doesn't recognise. Everyone else needs attestation.
describe("policy allowlist (staging)", () => {
  const SUBJECT = "109876543210987654321"; // googleClaims() default sub
  const ALLOWLIST = (list: string) => ({ ...REQUIRED(), ATTESTATION_POLICY: "allowlist", ATTESTATION_ALLOWLIST: list });

  it("no header, allowlisted account → 200", async () => {
    const { body } = await googleSignIn();
    const res = await send("/v1/auth/google", body, {}, ALLOWLIST(`apple:someone, google:${SUBJECT}`));
    expect(res.status).toBe(200);
  });

  it("no header, account not on the list → 403, nonce still usable", async () => {
    const { body } = await googleSignIn();
    await expectError(
      await send("/v1/auth/google", body, {}, ALLOWLIST("google:someone-else")),
      403,
      "attestation_failed",
    );
    expect(await count("sign_in_nonces")).toBe(1);
    expect(await count("sessions")).toBe(0);
  });

  it("the same subject from the other provider is not on the list", async () => {
    const { body } = await googleSignIn();
    await expectError(
      await send("/v1/auth/google", body, {}, ALLOWLIST(`apple:${SUBJECT}`)),
      403,
      "attestation_failed",
    );
  });

  it("no header and no list → 403", async () => {
    const { body } = await googleSignIn();
    const res = await send("/v1/auth/google", body, {}, { ...ALLOWLIST(""), ATTESTATION_ALLOWLIST: undefined });
    await expectError(res, 403, "attestation_failed");
  });

  it("a failing token is refused even for an allowlisted account", async () => {
    const { body, token } = await googleSignIn({ accountDetails: { appLicensingVerdict: "UNLICENSED" } });
    const res = await send("/v1/auth/google", body, { "zapakid-attestation": token }, ALLOWLIST(`google:${SUBJECT}`));
    await expectError(res, 403, "attestation_failed");
  });

  it("a genuine token works for anyone", async () => {
    const { body, token } = await googleSignIn();
    expect((await send("/v1/auth/google", body, { "zapakid-attestation": token }, ALLOWLIST(""))).status).toBe(200);
  });

  it("a bad Google token without header is 401, not let through", async () => {
    const body = JSON.stringify({ idToken: "a.b.c", ageRange: ADULT_GOOGLE, nonce: pendingNonce()?.nonce });
    await expectError(await send("/v1/auth/google", body, {}, ALLOWLIST(`google:${SUBJECT}`)), 401, "invalid_token");
  });
});

// Regression (2026-10-30): an Android kid phone pairing to an iPhone parent on staging got "Something went wrong" —
// its genuine integrity token met a server with no way to decode it (503). Keyless decode makes it work.
describe("kid pairing (staging)", () => {
  it("a genuine token on redeem → 200 kid session, for any parent", async () => {
    const parent = await signInParent(apple, "ana");
    const json = { "content-type": "application/json", ...parent.auth };
    const family = await (
      await call("/v1/families", { method: "POST", headers: json, body: JSON.stringify({ name: "Pop" }) })
    ).json<{ id: string }>();
    const kid = await (
      await call(`/v1/families/${family.id}/kids`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ nickname: "Mia", avatar: "robot-1", grade: 1 }),
      })
    ).json<{ id: string }>();
    const { code } = await (
      await call(`/v1/families/${family.id}/kids/${kid.id}/pairing`, { method: "POST", headers: parent.auth })
    ).json<{ code: string }>();
    const body = JSON.stringify({ code });
    const token = "integrity-token-pairing";
    verdicts.set(token, verdict(await sha256Hex(body)));
    const res = await send(
      "/v1/pairing/redeem",
      body,
      { "zapakid-attestation": token },
      {
        ...REQUIRED(),
        ATTESTATION_POLICY: "allowlist",
        ATTESTATION_ALLOWLIST: "",
      },
    );
    expect(res.status).toBe(200);
  });
});

describe("health", () => {
  const health = (overrides: Record<string, unknown>) =>
    worker.fetch(workerRequest("https://api.test/health"), { ...env, ...overrides });

  it("required without federation settings → 503 naming them", async () => {
    const res = await health({ ATTESTATION_POLICY: "required", PLAY_CERT_SHA256: CERT });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain("PLAY_INTEGRITY_WIF_AUDIENCE");
    expect(text).toContain("PLAY_INTEGRITY_SERVICE_ACCOUNT");
  });

  it("required without the API's signing key → 503 naming CHAT_TOKEN_SIGNING_KEY", async () => {
    const res = await health({ ...REQUIRED(), CHAT_TOKEN_SIGNING_KEY: undefined });
    expect(await res.text()).toContain("CHAT_TOKEN_SIGNING_KEY");
  });

  it("required without the signing certificate → 503 naming PLAY_CERT_SHA256", async () => {
    const res = await health({
      ...REQUIRED(),
      PLAY_CERT_SHA256: "",
    });
    expect(await res.text()).toContain("PLAY_CERT_SHA256");
  });

  it("allowlist without a list is healthy (nobody is exempt)", async () => {
    expect((await health({ ...REQUIRED(), ATTESTATION_POLICY: "allowlist" })).status).toBe(200);
  });

  it("an unknown policy → 503 naming ATTESTATION_POLICY", async () => {
    expect(await (await health({ ATTESTATION_POLICY: "maybe" })).text()).toContain("ATTESTATION_POLICY");
  });

  it("required with everything set → 200", async () => {
    expect((await health(REQUIRED())).status).toBe(200);
  });
});

// Google's WIF provider (issuer = CHAT_TOKEN_ISSUER) finds the API's public key through OIDC discovery.
describe("OIDC discovery", () => {
  it("names the issuer and its JWKS", async () => {
    const res = await worker.fetch(workerRequest("https://api.test/.well-known/openid-configuration"), env);
    expect(res.status).toBe(200);
    const doc = await res.json<Record<string, unknown>>();
    expect(doc.issuer).toBe(env.CHAT_TOKEN_ISSUER);
    expect(doc.jwks_uri).toBe(`${env.CHAT_TOKEN_ISSUER}/.well-known/jwks.json`);
    expect(doc.id_token_signing_alg_values_supported).toEqual(["ES256"]);
  });
});
