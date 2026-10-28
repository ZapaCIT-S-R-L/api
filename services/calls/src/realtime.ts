// Cloudflare Realtime SFU (https://developers.cloudflare.com/realtime/sfu/https-api/): the app secret stays here;
// phones reach the SFU only through the calls API, and only for their own session.
// TURN (https://developers.cloudflare.com/realtime/turn/generate-credentials/): short-lived ICE servers per call.
import type { Env } from "./env";
import { safeUrl } from "./urls";

const TIMEOUT_MS = 10_000;

export class RealtimeUnavailable extends Error {}

// Realtime refused the request (4xx): its errorCode/errorDescription, passed on to the phone.
export class RealtimeRejected extends Error {
  constructor(
    readonly upstreamStatus: number,
    message: string,
  ) {
    super(message);
  }
}

function base(env: Env): string {
  const url = safeUrl(env.REALTIME_API_URL);
  if (!url) throw new RealtimeUnavailable("REALTIME_API_URL is not a safe URL");
  return url.toString().replace(/\/$/, "");
}

async function send(url: string, secret: string, method: string, body: unknown): Promise<Response> {
  try {
    return await fetch(url, {
      method,
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new RealtimeUnavailable(`fetch failed: ${String(e)}`);
  }
}

// One SFU API call for the app: `path` is below /apps/{appId}. Returns the JSON body of a 2xx answer.
export async function sfu(env: Env, method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<unknown> {
  const appId = env.REALTIME_APP_ID;
  const secret = env.REALTIME_APP_SECRET;
  if (!appId || !secret) throw new RealtimeUnavailable("Realtime app credentials not set");
  const res = await send(`${base(env)}/apps/${encodeURIComponent(appId)}${path}`, secret, method, body);
  const json: unknown = await res.json().catch(() => null);
  if (res.status >= 500 || res.status === 401 || res.status === 403) {
    // 401/403: our app secret is wrong, not the phone's fault.
    throw new RealtimeUnavailable(`Realtime answered ${res.status}`);
  }
  if (!res.ok) {
    const description = (json as { errorDescription?: unknown } | null)?.errorDescription;
    throw new RealtimeRejected(res.status, typeof description === "string" ? description.slice(0, 200) : "refused");
  }
  return json ?? {};
}

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

// When TURN can't be reached the call still starts, peer-to-peer reachable networks only.
export const STUN_ONLY: IceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478"] }];

function isIceServer(value: unknown): value is { urls: string | string[]; username?: unknown; credential?: unknown } {
  if (typeof value !== "object" || value === null) return false;
  const urls = (value as { urls?: unknown }).urls;
  return typeof urls === "string" || (Array.isArray(urls) && urls.every((u) => typeof u === "string"));
}

// Short-lived TURN credentials (TTL ≤ 1 h). Never throws: falls back to STUN only, and logs why.
export async function iceServers(env: Env, ttlSeconds: number): Promise<IceServer[]> {
  try {
    const keyId = env.TURN_KEY_ID;
    const token = env.TURN_KEY_API_TOKEN;
    if (!keyId || !token) throw new RealtimeUnavailable("TURN key not set");
    const url = `${base(env)}/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
    const res = await send(url, token, "POST", { ttl: ttlSeconds });
    if (!res.ok) throw new RealtimeUnavailable(`TURN answered ${res.status}`);
    const body = await res.json<{ iceServers?: unknown }>();
    if (!Array.isArray(body.iceServers) || !body.iceServers.every(isIceServer) || body.iceServers.length === 0) {
      throw new RealtimeUnavailable("TURN answer has no iceServers");
    }
    return body.iceServers.map((s) => ({
      urls: typeof s.urls === "string" ? [s.urls] : s.urls,
      ...(typeof s.username === "string" ? { username: s.username } : {}),
      ...(typeof s.credential === "string" ? { credential: s.credential } : {}),
    }));
  } catch (e) {
    console.error(JSON.stringify({ msg: "turn unavailable, STUN only", err: String(e) }));
    return STUN_ONLY;
  }
}
