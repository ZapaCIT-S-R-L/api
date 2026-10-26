// One-time sign-in nonces. The app gets `nonce`, gives Apple/Google SHA-256(nonce) (hex), and sends `nonce` with
// the token. D1 keeps SHA-256(SHA-256(nonce)) only. A nonce is used up atomically (DELETE ... RETURNING), so a
// replayed token fails even when two requests race.
import { randomBase64Url, sha256Hex } from "./crypto";
import type { Env } from "./env";

export const NONCE_TTL_SECONDS = 600;
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class InvalidNonce extends Error {}

export async function issueNonce(env: Env): Promise<{ nonce: string; expiresAt: string }> {
  const nonce = randomBase64Url(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + NONCE_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare("INSERT INTO sign_in_nonces (nonce_hash, created_at, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256Hex(await sha256Hex(nonce)), now.toISOString(), expiresAt)
    .run();
  return { nonce, expiresAt };
}

// Checks the token's nonce claim against the nonce sent with it. Doesn't use the nonce up.
export async function checkNonceClaim(claim: unknown, nonce: string): Promise<string> {
  if (typeof claim !== "string") throw new InvalidNonce("token has no nonce claim");
  const expected = await sha256Hex(nonce);
  if (claim !== expected) throw new InvalidNonce("nonce claim doesn't match");
  return expected;
}

// Uses up the nonce whose SHA-256 is `claim`. Fails if it is unknown, expired or already used.
export async function consumeNonce(env: Env, claim: string): Promise<void> {
  const row = await env.DB.prepare(
    "DELETE FROM sign_in_nonces WHERE nonce_hash = ? AND expires_at > ? RETURNING nonce_hash",
  )
    .bind(await sha256Hex(claim), new Date().toISOString())
    .first();
  if (!row) throw new InvalidNonce("nonce unknown, expired or used");
}
