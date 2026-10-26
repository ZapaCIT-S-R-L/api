// Test-only identity providers: RSA keys generated per test run, tokens signed with them, and a fetch stub that
// serves their public keys at Apple's and Google's real JWKS URLs. No real token or key is ever used.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
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
export const APPLE_AUDIENCE = "com.zapacit.cuzaai";
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
}

// Replaces global fetch for the two JWKS URLs; anything else fails the test.
export function stubJwks(apple: TestIssuer[], google: TestIssuer[]): JwksStub {
  const stub: JwksStub = { apple: apple.map((i) => i.jwk), google: google.map((i) => i.jwk), calls: [], fail: false };
  vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input.toString();
    stub.calls.push(url);
    if (stub.fail) return Promise.resolve(new Response("unavailable", { status: 503 }));
    if (url === APPLE_JWKS) return Promise.resolve(Response.json({ keys: stub.apple }));
    if (url === GOOGLE_JWKS) return Promise.resolve(Response.json({ keys: stub.google }));
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
  return stub;
}

export function appleClaims(overrides: JWTPayload = {}): JWTPayload {
  return {
    iss: APPLE_ISSUER,
    aud: APPLE_AUDIENCE,
    sub: "001234.apple-subject.0001",
    email: "parent@privaterelay.appleid.com",
    email_verified: "true",
    ...overrides,
  };
}

export function googleClaims(overrides: JWTPayload = {}): JWTPayload {
  return {
    iss: GOOGLE_ISSUER,
    aud: GOOGLE_AUDIENCE,
    azp: GOOGLE_AUDIENCE,
    sub: "109876543210987654321",
    email: "parent@example.com",
    email_verified: true,
    name: "Test Parent",
    ...overrides,
  };
}

export const ADULT = { source: "apple_declared_age_range", lowerBound: 18, upperBound: null } as const;
export const ADULT_GOOGLE = {
  source: "google_play_age_signals",
  lowerBound: 18,
  upperBound: null,
  platformStatus: "VERIFIED",
} as const;

// Calls the Worker module directly (same module instance as the test), so tests can reset its JWKS cache.
export async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://api.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return call(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function count(table: "parents" | "parent_identities" | "sessions"): Promise<number> {
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
