// Bindings and variables from wrangler.jsonc.
import type { CallRoom } from "./call-room";

export interface Env {
  // The call log (metadata only, never audio).
  DB: D1Database;
  // One Durable Object per call (src/call-room.ts): roster, key envelope relay, events WebSocket, timers.
  CALL: DurableObjectNamespace<CallRoom>;
  // Calls started and joins, per account per minute (wrangler.jsonc ratelimits).
  CREATE_LIMITER: RateLimit;
  JOIN_LIMITER: RateLimit;
  VERSION: string;
  VERSION_URL: string;
  // Chat tokens: the account API's key set (https, or http on loopback locally), its origin (`iss`) and this
  // service's host (`aud`).
  ACCOUNT_JWKS_URL: string;
  TOKEN_ISSUER: string;
  TOKEN_AUDIENCE: string;
  // Cloudflare Realtime (SFU sessions and the TURN key API): https://rtc.live.cloudflare.com/v1.
  REALTIME_API_URL: string;
  // Limits (src/limits.ts).
  MAX_PARTICIPANTS: string;
  RING_TIMEOUT_SECONDS: string;
  MAX_CALL_SECONDS: string;
  TURN_TTL_SECONDS: string;
  RECONNECT_GRACE_SECONDS: string;
  CALL_LOG_RETENTION_DAYS: string;
  // Secrets Stefan sets (scripts/set-secrets.sh): the Realtime app and the TURN key. Never vars, never logged.
  REALTIME_APP_ID?: string | undefined;
  REALTIME_APP_SECRET?: string | undefined;
  TURN_KEY_ID?: string | undefined;
  TURN_KEY_API_TOKEN?: string | undefined;
}

type AppEnv = Env;

declare global {
  // `env` from cloudflare:workers and cloudflare:test has this shape.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env extends AppEnv {
      // Tests only (vitest.config.ts).
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    }
    // Types `exports` from cloudflare:workers (tests call exports.default.fetch).
    interface GlobalProps {
      mainModule: typeof import("./index");
      durableNamespaces: "CallRoom";
    }
  }
}
