// The account service's public signing keys (JWKS), fetched and cached per isolate.
// Cached for an hour. A token with an unknown key id triggers one refetch (the account service rotated its key), at
// most every 5 minutes, so random key ids can't make us hammer it. A failed fetch serves the cached keys for up to a
// day, so chat keeps working through an account service outage.
import { createLocalJWKSet, type JSONWebKeySet } from "jose";

const TTL_MS = 60 * 60 * 1000;
const STALE_OK_MS = 24 * 60 * 60 * 1000;
const REFETCH_COOLDOWN_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

interface Entry {
  keys: JSONWebKeySet;
  fetchedAt: number;
  triedAt: number;
}

const cache = new Map<string, Entry>();

export class KeysUnavailable extends Error {}

export function resetJwksCache(): void {
  cache.clear();
}

// https everywhere; plain http only for a key server on this machine (local tests).
export function allowedJwksUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

async function download(url: string): Promise<Entry> {
  const stale = cache.get(url);
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new KeysUnavailable(`JWKS ${url} answered ${res.status}`);
    const body: unknown = await res.json().catch(() => null);
    if (!isJwks(body)) throw new KeysUnavailable(`JWKS ${url} is not a key set`);
    const now = Date.now();
    const entry = { keys: body, fetchedAt: now, triedAt: now };
    cache.set(url, entry);
    return entry;
  } catch (e) {
    if (stale && Date.now() - stale.fetchedAt < STALE_OK_MS) {
      stale.triedAt = Date.now();
      return stale;
    }
    throw e instanceof KeysUnavailable ? e : new KeysUnavailable(`JWKS fetch failed: ${String(e)}`);
  }
}

function isJwks(value: unknown): value is JSONWebKeySet {
  return typeof value === "object" && value !== null && Array.isArray((value as { keys?: unknown }).keys);
}

// The key set at `url`, refreshed once if it doesn't know `kid`.
export async function getJwks(url: string, kid: string | undefined): Promise<ReturnType<typeof createLocalJWKSet>> {
  let entry = cache.get(url);
  if (!entry || Date.now() - entry.fetchedAt >= TTL_MS) entry = await download(url);
  const known = entry.keys.keys.some((k) => k.kid === kid);
  if (!known && Date.now() - entry.triedAt >= REFETCH_COOLDOWN_MS) entry = await download(url);
  return createLocalJWKSet(entry.keys);
}
