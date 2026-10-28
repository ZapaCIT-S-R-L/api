// Bindings and variables from wrangler.jsonc.
export interface Env {
  DB: D1Database;
  // Conversations started per account per minute.
  CREATE_LIMITER: RateLimit;
  VERSION: string;
  VERSION_URL: string;
  // Chat tokens: the account service's host (`iss`), this service's host (in `aud`) and the account JWKS.
  TOKEN_ISSUER: string;
  TOKEN_AUDIENCE: string;
  ACCOUNT_JWKS_URL: string;
  // Local only ("on"): POST /__e2e/membership, loopback requests only. Never set when deployed.
  E2E_HOOKS?: string;
  MEMBERSHIP_E2E?: Queue;
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
    interface GlobalProps {
      mainModule: typeof import("./index");
    }
  }
}
