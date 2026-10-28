// Sessions: a random opaque token for the app, only its SHA-256 in D1.
import { randomBase64Url, sha256Hex } from "./crypto";
import type { Env } from "./env";

const TOKEN_PREFIX = "zks_";
const TOKEN_PATTERN = /^zks_[A-Za-z0-9_-]{43}$/;

export function newToken(): string {
  return TOKEN_PREFIX + randomBase64Url(32);
}

export function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
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
  // The device registered on this session (POST /v1/devices), or null.
  deviceId: number | null;
}

const DAY_MS = 86_400_000;

// The live session for this request, or null. Expired sessions are deleted when seen.
export async function authenticate(request: Request, env: Env): Promise<Session | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const tokenHash = await hashToken(token);
  const row = await env.DB.prepare("SELECT parent_id, expires_at, device_id FROM sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ parent_id: string; expires_at: string; device_id: number | null }>();
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }
  await touchDevice(env, row.parent_id, row.device_id);
  return { tokenHash, parentId: row.parent_id, deviceId: row.device_id };
}

// Device activity for the 90-day expiry; written at most once a day per device.
export async function touchDevice(env: Env, accountId: string, deviceId: number | null): Promise<void> {
  if (deviceId === null) return;
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE devices SET last_seen_at = ? WHERE account_id = ? AND device_id = ? AND last_seen_at < ?",
  )
    .bind(new Date(now).toISOString(), accountId, deviceId, new Date(now - DAY_MS).toISOString())
    .run();
}
