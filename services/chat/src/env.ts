// Bindings and variables from wrangler.jsonc.
export interface Env {
  DB: D1Database;
  // One Durable Object per conversation: delivery copies and the stream (src/room.ts).
  ROOMS: DurableObjectNamespace<import("./room").ConversationRoom>;
  // "eu" when deployed: the conversation objects live in the EU jurisdiction.
  ROOMS_JURISDICTION?: string;
  // Per account per minute: conversations started. Per device per minute: sends, stream connects.
  CREATE_LIMITER: RateLimit;
  SEND_LIMITER: RateLimit;
  CONNECT_LIMITER: RateLimit;
  // Per device per minute: attachment reservations and download URLs.
  ATTACH_LIMITER: RateLimit;
  // Encrypted attachments (EU jurisdiction when deployed), keyed by attachment id.
  ATTACHMENTS: R2Bucket;
  VERSION: string;
  VERSION_URL: string;
  // Chat tokens: the account service's host (`iss`), this service's host (in `aud`) and the account JWKS.
  TOKEN_ISSUER: string;
  TOKEN_AUDIENCE: string;
  ACCOUNT_JWKS_URL: string;
  // Conversation events for the calls service (src/conversation-events.ts): producer on the queue
  // zapakid-conversation-events-<env>. Optional: until an environment has the queue, events wait in the D1 outbox.
  CONVERSATION_EVENTS?: Queue;
  // Local only ("on"): POST /__e2e/membership, loopback requests only. Never set when deployed.
  E2E_HOOKS?: string;
  // APNs alert pushes (src/push.ts): the key is a Worker secret (APNS_AUTH_KEY, never a var); the rest are vars.
  APNS_AUTH_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
  APNS_ENVIRONMENT?: string;
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
