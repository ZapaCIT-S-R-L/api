// Test-only chat token issuer: an ES256 key generated per test run, tokens signed with it, and a fetch stub that
// serves its public key at the account API's JWKS URL (wrangler.jsonc, top level). No real key is ever used.
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import { vi } from "vitest";

export const ISSUER = "http://localhost:8787";
export const AUDIENCE = "calls.localhost";

export interface TestIssuer {
  kid: string;
  jwk: JWK;
  sign(claims: JWTPayload, options?: { kid?: string; ttl?: number; iat?: number }): Promise<string>;
}

let counter = 0;

export async function makeIssuer(kid = `calls-test-key-${++counter}`): Promise<TestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
  return {
    kid,
    jwk,
    sign: (claims, options = {}) => {
      const iat = options.iat ?? Math.floor(Date.now() / 1000);
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "ES256", kid: options.kid ?? kid, typ: "JWT" })
        .setIssuedAt(iat)
        .setExpirationTime(iat + (options.ttl ?? 600))
        .sign(privateKey);
    },
  };
}

// The claims the account API puts in a chat token (api: src/chat-token.ts). Overrides may set one to undefined.
export function chatClaims(overrides: Record<string, unknown> = {}): JWTPayload {
  return {
    iss: ISSUER,
    aud: ["chat.localhost", AUDIENCE],
    sub: "account-1",
    dev: 1,
    role: "parent",
    conv: ["conv-1"],
    jti: `jti-${++counter}`,
    ...overrides,
  };
}

export interface FetchStub {
  keys: JWK[];
  jwksCalls: number;
  failJwks: boolean;
  // Other URLs a test serves (Realtime, TURN); undefined = unexpected.
  other?: (url: string, init: RequestInit | undefined) => Promise<Response> | undefined;
}

// Replaces global fetch: the account JWKS, plus whatever `other` serves. Anything else fails the test.
export function stubFetch(issuers: TestIssuer[]): FetchStub {
  const stub: FetchStub = { keys: issuers.map((i) => i.jwk), jwksCalls: 0, failJwks: false };
  vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === env.ACCOUNT_JWKS_URL) {
      stub.jwksCalls++;
      if (stub.failJwks) return Promise.resolve(new Response("unavailable", { status: 503 }));
      return Promise.resolve(Response.json({ keys: stub.keys }));
    }
    const other = stub.other?.(url, init);
    if (other) return other;
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
  return stub;
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export interface ErrorBody {
  error: { code: string; message: string };
}
