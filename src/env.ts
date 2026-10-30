// Bindings and variables from wrangler.jsonc.
export interface Env {
  DB: D1Database;
  // Nonce + sign-in requests per client address per minute (wrangler.jsonc ratelimits).
  AUTH_LIMITER: RateLimit;
  VERSION: string;
  VERSION_URL: string;
  // Comma-separated accepted audiences: Apple iOS bundle id and web-flow Services id, Google OAuth client ids. Empty = provider off.
  APPLE_BUNDLE_IDS: string;
  // The Services ID(s) of Apple's web flow (Android), accepted only by its callback. Empty = web flow off.
  APPLE_SERVICES_IDS: string;
  GOOGLE_CLIENT_IDS: string;
  // Where the Apple web flow (Android) hands the result back to the app: an Android App Link.
  APPLE_WEB_REDIRECT_URL: string;
  SESSION_TTL_SECONDS: string;
  // App attestation on sign-in: "required" (production), "allowlist" (staging), "optional" (local only); see
  // src/play-integrity.ts.
  ATTESTATION_POLICY: string;
  // Play Integrity: the app's package, and its signing certificate SHA-256 digests as Play reports them (comma
  // separated: Play app signing key, and the upload key for internal testing if needed).
  PLAY_PACKAGE_NAME: string;
  PLAY_CERT_SHA256: string;
  // App Attest: "<team id>.<bundle id>", and the key environments accepted ("development" = Xcode builds).
  APP_ATTEST_APP_ID: string;
  APP_ATTEST_ENVIRONMENTS: string;
  // Chat tokens (src/chat-token.ts): the issuer (this API's origin), the accepted audiences (the chat and calls
  // hosts, comma separated) and the lifetime in seconds (60 to 900).
  CHAT_TOKEN_ISSUER: string;
  CHAT_TOKEN_AUDIENCES: string;
  CHAT_TOKEN_TTL_SECONDS: string;
  // Secret (scripts/set-chat-token-key.sh): the private P-256 JWK that signs chat tokens.
  CHAT_TOKEN_SIGNING_KEY?: string | undefined;
  // Play Integrity decode, keyless (src/play-integrity.ts): the Workload Identity provider that trusts this API's
  // issuer ("//iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<id>")
  // and the service account it may impersonate. Empty: integrity tokens can't be checked (503).
  PLAY_INTEGRITY_WIF_AUDIENCE?: string;
  PLAY_INTEGRITY_SERVICE_ACCOUNT?: string;
  // Secret (staging): "provider:subject" test accounts allowed to sign in without attestation, comma separated.
  ATTESTATION_ALLOWLIST?: string;
  // Queue producer for membership events to the chat and calls services (src/membership-events.ts). Optional: until
  // an environment has the queue, events wait in the D1 outbox.
  MEMBERSHIP_EVENTS?: Queue;
  // Local development only: a JWKS URL on 127.0.0.1/localhost for test keys. Anything else is ignored.
  APPLE_JWKS_URL?: string;
  GOOGLE_JWKS_URL?: string;
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
