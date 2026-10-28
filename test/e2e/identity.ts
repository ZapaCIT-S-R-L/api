// Test sign-in for the e2e files: tokens signed with this run's test keys (global-setup.ts), and a helper that
// signs a parent in through the real API (fresh nonce, Apple token, adult age range).
import { createHash } from "node:crypto";
import { importJWK, SignJWT, type JWTPayload } from "jose";
import { expect, inject } from "vitest";
import { api, bodyOf } from "./base";

export const GOOGLE_AUDIENCE = "000000000000-zapakidlocaltest.apps.googleusercontent.com";
export const ADULT = { availability: "shared", source: "apple_declared_age_range", lowerBound: 18, upperBound: null };

export type Provider = "apple" | "google";

export async function signToken(provider: Provider, claims: JWTPayload, exp?: number | string): Promise<string> {
  const { kid, privateJwk } = inject("testKeys")[provider];
  const key = await importJWK(privateJwk, "RS256");
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt()
    .setExpirationTime(exp ?? "10m")
    .sign(key);
}

export const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  api(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

// A fresh one-time nonce from the API; the token carries its SHA-256 (hex).
export async function freshNonce(): Promise<{ nonce: string; hash: string }> {
  const res = await api("/v1/auth/nonce", { method: "POST" });
  expect(res.status).toBe(200);
  const { nonce } = await bodyOf<{ nonce: string }>(res);
  return { nonce, hash: createHash("sha256").update(nonce).digest("hex") };
}

export interface SignedInParent {
  token: string;
  id: string;
  auth: Record<string, string>;
}

// Signs a parent in with Apple (test keys) and returns the session.
export async function signInParent(sub: string, displayName = "E2E Parent"): Promise<SignedInParent> {
  const { nonce, hash } = await freshNonce();
  const identityToken = await signToken("apple", {
    iss: "https://appleid.apple.com",
    aud: "ro.zapakid.app",
    sub,
    nonce: hash,
  });
  const res = await post("/v1/auth/apple", { identityToken, ageRange: ADULT, nonce, displayName });
  expect(res.status).toBe(200);
  const body = await bodyOf<{ session: { token: string }; parent: { id: string } }>(res);
  return { token: body.session.token, id: body.parent.id, auth: { authorization: `Bearer ${body.session.token}` } };
}
