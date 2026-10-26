// Play Integrity on sign-in (Android): a standard integrity token in ZapaKid-Attestation whose requestHash is the
// SHA-256 (hex) of the exact body. The server decodes it with Google's API (service account, OAuth JWT grant) and
// checks the verdicts. Google's endpoints are served by the test with keys generated here.
import { env } from "cloudflare:workers";
import { exportPKCS8, generateKeyPair, jwtVerify, type CryptoKey } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
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
  type ErrorBody,
  type JwksStub,
  type TestIssuer,
} from "./helpers";
import { resetPlayIntegrityCache } from "../../src/play-integrity";

const PACKAGE = "ro.zapakid.app";
const CERT = "xYzSigningCertDigestBase64UrlNoPadding0123456";
const SA_EMAIL = "play-integrity@zapakid-test.iam.gserviceaccount.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DECODE_URL = `https://playintegrity.googleapis.com/v1/${PACKAGE}:decodeIntegrityToken`;

let google: TestIssuer;
let apple: TestIssuer;
let jwks: JwksStub;
let saPublic: CryptoKey;
let credentials: string;
let verdicts: Map<string, unknown>;
let tokenCalls: number;
let decodeStatus: number;

beforeEach(async () => {
  resetJwksCache();
  resetPlayIntegrityCache();
  google = await makeIssuer();
  apple = await makeIssuer();
  jwks = stubJwks([apple], [google]);
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  saPublic = publicKey;
  credentials = JSON.stringify({
    type: "service_account",
    client_email: SA_EMAIL,
    private_key: await exportPKCS8(privateKey),
  });
  verdicts = new Map();
  tokenCalls = 0;
  decodeStatus = 200;
  jwks.other = (url, init) => {
    if (url === TOKEN_URL) return oauthToken(init);
    if (url === DECODE_URL) return decode(init);
    return undefined;
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Google's OAuth token endpoint: accepts only a JWT grant signed by the service account for Play Integrity.
async function oauthToken(init: RequestInit | undefined): Promise<Response> {
  tokenCalls++;
  const form = new URLSearchParams(String(init?.body));
  if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer")
    return new Response("bad grant", { status: 400 });
  try {
    const { payload } = await jwtVerify(form.get("assertion") ?? "", saPublic, {
      issuer: SA_EMAIL,
      audience: TOKEN_URL,
    });
    if (payload.scope !== "https://www.googleapis.com/auth/playintegrity") throw new Error("scope");
  } catch {
    return new Response("invalid_grant", { status: 400 });
  }
  return Response.json({ access_token: "ya29.test-access-token", expires_in: 3600, token_type: "Bearer" });
}

// Google's decodeIntegrityToken: the verdict the test registered for this token.
function decode(init: RequestInit | undefined): Promise<Response> {
  if (decodeStatus !== 200) return Promise.resolve(new Response("error", { status: decodeStatus }));
  const auth = new Headers(init?.headers).get("authorization");
  if (auth !== "Bearer ya29.test-access-token")
    return Promise.resolve(new Response("unauthenticated", { status: 401 }));
  const { integrity_token } = JSON.parse(String(init?.body)) as { integrity_token: string };
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
  PLAY_INTEGRITY_CREDENTIALS: credentials,
  PLAY_CERT_SHA256: CERT,
});

async function send(path: string, body: string, headers: Record<string, string>, overrides: Record<string, unknown>) {
  const request = new Request(`https://api.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `10.9.${Math.floor(Math.random() * 255)}.1`,
      ...headers,
    },
    body,
  }) as Parameters<typeof worker.fetch>[0];
  return worker.fetch(request, { ...env, ...overrides } as typeof env);
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
        ? { requestDetails: { ...(overrides.requestDetails as object), requestHash: v.requestDetails.requestHash } }
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
      { ...REQUIRED(), PLAY_INTEGRITY_CREDENTIALS: undefined },
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

describe("policy optional (staging until Play Integrity is set up)", () => {
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
      { ...OPTIONAL(), PLAY_INTEGRITY_CREDENTIALS: undefined },
    );
    await expectError(res, 503, "attestation_unavailable");
  });
});

describe("health", () => {
  const health = (overrides: Record<string, unknown>) =>
    worker.fetch(
      new Request("https://api.test/health") as Parameters<typeof worker.fetch>[0],
      { ...env, ...overrides } as typeof env,
    );

  it("required without a service account → 503 naming PLAY_INTEGRITY_CREDENTIALS", async () => {
    const res = await health({ ATTESTATION_POLICY: "required", PLAY_CERT_SHA256: CERT });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("PLAY_INTEGRITY_CREDENTIALS");
  });

  it("required without the signing certificate → 503 naming PLAY_CERT_SHA256", async () => {
    const res = await health({
      ATTESTATION_POLICY: "required",
      PLAY_INTEGRITY_CREDENTIALS: credentials,
      PLAY_CERT_SHA256: "",
    });
    expect(await res.text()).toContain("PLAY_CERT_SHA256");
  });

  it("an unknown policy → 503 naming ATTESTATION_POLICY", async () => {
    expect(await (await health({ ATTESTATION_POLICY: "maybe" })).text()).toContain("ATTESTATION_POLICY");
  });

  it("required with everything set → 200, and the credentials never appear", async () => {
    const res = await health(REQUIRED());
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("PRIVATE KEY");
  });
});
