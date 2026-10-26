// Bindings and variables from wrangler.jsonc.
export interface Env {
  VERSION: string;
  VERSION_URL: string;
}

type AppEnv = Env;

declare global {
  // `env` from cloudflare:workers and cloudflare:test has this shape.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends AppEnv {}
    // Types `exports` from cloudflare:workers (tests call exports.default.fetch).
    interface GlobalProps {
      mainModule: typeof import("./index");
    }
  }
}
