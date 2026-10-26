// Apple's and Google's public signing keys (JWKS), fetched and cached per isolate.
// Cached for an hour. A token with an unknown key id triggers one refetch (the provider rotated its keys), at most
// every 5 minutes per provider, so random key ids can't make us hammer Apple or Google.
import { createLocalJWKSet, type JSONWebKeySet } from "jose";

const TTL_MS = 60 * 60 * 1000;
const REFETCH_COOLDOWN_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

interface Entry {
  keys: JSONWebKeySet;
  fetchedAt: number;
}

const cache = new Map<string, Entry>();

export class ProviderUnavailable extends Error {}

export function resetJwksCache(): void {
  cache.clear();
}

async function download(url: string): Promise<Entry> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json" } });
  } catch (e) {
    throw new ProviderUnavailable(`JWKS fetch failed: ${String(e)}`);
  }
  if (!res.ok) throw new ProviderUnavailable(`JWKS fetch ${url} answered ${res.status}`);
  const body: unknown = await res.json().catch(() => null);
  if (!isJwks(body)) throw new ProviderUnavailable(`JWKS ${url} is not a key set`);
  const entry = { keys: body, fetchedAt: Date.now() };
  cache.set(url, entry);
  return entry;
}

function isJwks(value: unknown): value is JSONWebKeySet {
  return typeof value === "object" && value !== null && Array.isArray((value as { keys?: unknown }).keys);
}

async function current(url: string): Promise<Entry> {
  const entry = cache.get(url);
  if (entry && Date.now() - entry.fetchedAt < TTL_MS) return entry;
  return download(url);
}

// The key set for `url`, and whether it may be refreshed for an unknown key id.
export async function getJwks(url: string, kid: string | undefined): Promise<ReturnType<typeof createLocalJWKSet>> {
  let entry = await current(url);
  const known = entry.keys.keys.some((k) => k.kid === kid);
  if (!known && Date.now() - entry.fetchedAt >= REFETCH_COOLDOWN_MS) entry = await download(url);
  return createLocalJWKSet(entry.keys);
}
