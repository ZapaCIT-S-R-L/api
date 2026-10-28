// Test-only identity providers: RSA keys generated per test run, tokens signed with them, and a fetch stub that
// serves their public keys at Apple's and Google's real JWKS URLs. No real token or key is ever used.
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import { vi } from "vitest";
import worker from "../../src/index";
import { resetJwksCache } from "../../src/jwks";

export { resetJwksCache };

export const APPLE_JWKS = "https://appleid.apple.com/auth/keys";
export const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
export const APPLE_ISSUER = "https://appleid.apple.com";
export const GOOGLE_ISSUER = "https://accounts.google.com";
export const APPLE_AUDIENCE = "ro.zapakid.app";
// Matches the local test Services ID in APPLE_AUDIENCES (top-level vars of wrangler.jsonc).
export const APPLE_SERVICES_ID = "ro.zapakid.signin.local";
// Matches GOOGLE_CLIENT_IDS in the top level (local) vars of wrangler.jsonc.
export const GOOGLE_AUDIENCE = "000000000000-zapakidlocaltest.apps.googleusercontent.com";

export interface TestIssuer {
  kid: string;
  jwk: JWK;
  sign(claims: JWTPayload, options?: { alg?: string; kid?: string; expiresIn?: string | number }): Promise<string>;
}

let counter = 0;

export async function makeIssuer(kid = `test-key-${++counter}`): Promise<TestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  return {
    kid,
    jwk,
    sign: (claims, options = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: options.alg ?? "RS256", kid: options.kid ?? kid })
        .setIssuedAt()
        .setExpirationTime(options.expiresIn ?? "10m")
        .sign(privateKey),
  };
}

export interface JwksStub {
  apple: JWK[];
  google: JWK[];
  calls: string[];
  fail: boolean;
  // Other URLs a test serves (Google's OAuth and Play Integrity endpoints); undefined = unexpected.
  other?: (url: string, init: RequestInit | undefined) => Promise<Response> | undefined;
}

// Replaces global fetch for the two JWKS URLs; anything else fails the test.
export function stubJwks(apple: TestIssuer[], google: TestIssuer[]): JwksStub {
  const stub: JwksStub = { apple: apple.map((i) => i.jwk), google: google.map((i) => i.jwk), calls: [], fail: false };
  vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    stub.calls.push(url);
    if (stub.fail) return Promise.resolve(new Response("unavailable", { status: 503 }));
    if (url === APPLE_JWKS) return Promise.resolve(Response.json({ keys: stub.apple }));
    if (url === GOOGLE_JWKS) return Promise.resolve(Response.json({ keys: stub.google }));
    const other = stub.other?.(url, init);
    if (other) return other;
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
  return stub;
}

// Overrides may set a claim to undefined to leave it out.
export function appleClaims(overrides: Record<string, unknown> = {}): JWTPayload {
  return {
    iss: APPLE_ISSUER,
    aud: APPLE_AUDIENCE,
    sub: "001234.apple-subject.0001",
    email: "parent@privaterelay.appleid.com",
    email_verified: "true",
    nonce: pending?.hash,
    ...overrides,
  };
}

export function googleClaims(overrides: Record<string, unknown> = {}): JWTPayload {
  return {
    iss: GOOGLE_ISSUER,
    aud: GOOGLE_AUDIENCE,
    azp: GOOGLE_AUDIENCE,
    sub: "109876543210987654321",
    email: "parent@example.com",
    email_verified: true,
    name: "Test Parent",
    nonce: pending?.hash,
    ...overrides,
  };
}

export const ADULT = {
  availability: "shared",
  source: "apple_declared_age_range",
  lowerBound: 18,
  upperBound: null,
} as const;
export const ADULT_GOOGLE = {
  availability: "shared",
  source: "google_play_age_signals",
  lowerBound: 18,
  upperBound: null,
  platformStatus: "VERIFIED",
} as const;

// Calls the Worker module directly (same module instance as the test), so tests can reset its JWKS cache.
// A Request typed as the Worker's fetch expects (the runtime adds `cf`; tests don't).
export function workerRequest(url: string, init: RequestInit = {}): Parameters<typeof worker.fetch>[0] {
  const request: Request = new Request(url, init);
  return request as Parameters<typeof worker.fetch>[0];
}

// Each call comes from a random private IP (unless the test sets cf-connecting-ip), so the auth rate
// limit only applies in test/worker/rate-limit.test.ts.
export function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("cf-connecting-ip")) {
    headers.set("cf-connecting-ip", `10.${rand()}.${rand()}.${rand()}`);
  }
  const request = new Request(`https://api.test${path}`, { ...init, headers }) as Parameters<typeof worker.fetch>[0];
  return worker.fetch(request, env);
}

function rand(): number {
  return Math.floor(Math.random() * 256);
}

// Sign-in needs a one-time nonce from POST /v1/auth/nonce, and the token must carry its SHA-256 (hex) in the
// `nonce` claim. The tests keep one pending nonce: appleClaims()/googleClaims() put its hash in the token,
// postJson() adds it to sign-in bodies that have no `nonce` key and then fetches the next one.
let pending: { nonce: string; hash: string } | null = null;

export async function primeNonce(): Promise<{ nonce: string; hash: string }> {
  const res = await call("/v1/auth/nonce", { method: "POST" });
  if (res.status !== 200) throw new Error(`POST /v1/auth/nonce answered ${res.status}`);
  const { nonce } = await res.json<{ nonce: string }>();
  pending = { nonce, hash: await sha256Hex(nonce) };
  return pending;
}

export function pendingNonce(): { nonce: string; hash: string } | null {
  return pending;
}

const SIGN_IN = new Set(["/v1/auth/apple", "/v1/auth/google"]);

export async function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const isObject = typeof body === "object" && body !== null && !Array.isArray(body);
  const signIn = SIGN_IN.has(path);
  const withNonce = signIn && isObject && pending && !("nonce" in body) ? { ...body, nonce: pending.nonce } : body;
  const res = await call(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof withNonce === "string" ? withNonce : JSON.stringify(withNonce),
  });
  if (signIn) await primeNonce();
  return res;
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function count(
  table:
    | "parents"
    | "parent_identities"
    | "sessions"
    | "sign_in_nonces"
    | "apple_web_flows"
    | "app_attest_challenges"
    | "app_attest_keys"
    | "account_identities"
    | "devices"
    | "one_time_prekeys"
    | "pq_one_time_prekeys"
    | "families"
    | "family_parents"
    | "family_invitations"
    | "kids",
): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

export interface SignInBody {
  session: { token: string; expiresAt: string };
  parent: {
    id: string;
    email: string | null;
    displayName: string | null;
    ageRange: {
      category: string;
      source: string;
      lowerBound: number | null;
      upperBound: number | null;
      platformStatus: string | null;
      checkedAt: string;
    };
    createdAt: string;
  };
  newAccount: boolean;
}

export interface ErrorBody {
  error: { code: string; message: string };
}

// Signs a parent in with Apple (the given test issuer) and returns the session token and parent id.
export async function signInParent(
  apple: TestIssuer,
  sub: string,
  displayName = "Ana",
): Promise<{ token: string; id: string; auth: Record<string, string> }> {
  const res = await postJson("/v1/auth/apple", {
    identityToken: await apple.sign(appleClaims({ sub })),
    ageRange: ADULT,
    displayName,
  });
  if (res.status !== 200) throw new Error(`sign-in answered ${res.status}`);
  const body = await res.json<SignInBody>();
  return { token: body.session.token, id: body.parent.id, auth: bearer(body.session.token) };
}
