// Bindings and variables from wrangler.jsonc.
export interface Env {
  // The call log (metadata only, never audio).
  DB: D1Database;
  VERSION: string;
  VERSION_URL: string;
  // Chat tokens: the account API's key set (https, or http on loopback locally), its origin (`iss`) and this
  // service's host (`aud`).
  ACCOUNT_JWKS_URL: string;
  TOKEN_ISSUER: string;
  TOKEN_AUDIENCE: string;
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
    }
  }
}
