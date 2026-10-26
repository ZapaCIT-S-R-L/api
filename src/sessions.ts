// Sessions: a random opaque token for the app, only its SHA-256 in D1.
import type { Env } from "./env";

const TOKEN_PREFIX = "zks_";
const TOKEN_PATTERN = /^zks_[A-Za-z0-9_-]{43}$/;

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes));
  return TOKEN_PREFIX + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function ttlSeconds(env: Env): number {
  const ttl = Number(env.SESSION_TTL_SECONDS);
  if (!Number.isInteger(ttl) || ttl < 300 || ttl > 31_536_000) {
    throw new Error("SESSION_TTL_SECONDS must be an integer from 300 to 31536000");
  }
  return ttl;
}

// The bearer token from `Authorization: Bearer <token>`, or null if absent or not shaped like one of ours.
export function bearerToken(request: Request): string | null {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "");
  const token = match?.[1];
  return token && TOKEN_PATTERN.test(token) ? token : null;
}

export interface Session {
  tokenHash: string;
  parentId: string;
}

// The live session for this request, or null. Expired sessions are deleted when seen.
export async function authenticate(request: Request, env: Env): Promise<Session | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const tokenHash = await hashToken(token);
  const row = await env.DB.prepare("SELECT parent_id, expires_at FROM sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ parent_id: string; expires_at: string }>();
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }
  return { tokenHash, parentId: row.parent_id };
}
