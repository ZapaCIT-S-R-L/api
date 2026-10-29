// Test-only chat token issuer: an ES256 key generated per test run, tokens signed with it, and a fetch stub that
// serves its public key at the account API's JWKS URL (wrangler.jsonc, top level). No real key is ever used.
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import { vi } from "vitest";

export const ISSUER = "http://localhost:8787";
export const AUDIENCE = "calls.localhost";

export interface TestIssuer {
  kid: string;
  jwk: JWK;
  sign(claims: JWTPayload, options?: { kid?: string; ttl?: number; iat?: number }): Promise<string>;
}

let counter = 0;

export async function makeIssuer(kid = `calls-test-key-${++counter}`): Promise<TestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
  return {
    kid,
    jwk,
    sign: (claims, options = {}) => {
      const iat = options.iat ?? Math.floor(Date.now() / 1000);
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "ES256", kid: options.kid ?? kid, typ: "JWT" })
        .setIssuedAt(iat)
        .setExpirationTime(iat + (options.ttl ?? 600))
        .sign(privateKey);
    },
  };
}

// The claims the account API puts in a chat token (api: src/chat-token.ts). `conv` holds membership scopes
// (family:<id>, connection:<id>), never conversation ids: the chat service decides membership (test/chat-stub).
// Overrides may set one to undefined.
export function chatClaims(overrides: Record<string, unknown> = {}): JWTPayload {
  return {
    iss: ISSUER,
    aud: ["chat.localhost", AUDIENCE],
    sub: "account-1",
    dev: 1,
    role: "parent",
    conv: ["family:fam-test", "connection:con-test"],
    jti: `jti-${++counter}`,
    ...overrides,
  };
}

export interface FetchStub {
  keys: JWK[];
  jwksCalls: number;
  failJwks: boolean;
  // Other URLs a test serves (Realtime, TURN); undefined = unexpected.
  other?: (url: string, init: RequestInit | undefined) => Promise<Response> | undefined;
}

// Replaces global fetch: the account JWKS, plus whatever `other` serves. Anything else fails the test.
export function stubFetch(issuers: TestIssuer[]): FetchStub {
  const stub: FetchStub = { keys: issuers.map((i) => i.jwk), jwksCalls: 0, failJwks: false };
  vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === env.ACCOUNT_JWKS_URL) {
      stub.jwksCalls++;
      if (stub.failJwks) return Promise.resolve(new Response("unavailable", { status: 503 }));
      return Promise.resolve(Response.json({ keys: stub.keys }));
    }
    const other = stub.other?.(url, init);
    if (other) return other;
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
  return stub;
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export interface ErrorBody {
  error: { code: string; message: string };
}

// ---- Calls: a fake Cloudflare Realtime (SFU sessions/tracks) and TURN key API behind the fetch stub ----

export const REALTIME = "https://rtc.live.cloudflare.com/v1";

export interface FakeTrack {
  location: "local" | "remote";
  mid: string;
  trackName: string;
  sessionId?: string;
}

export interface FakeRealtime {
  requests: { method: string; path: string; auth: string | null; body: unknown }[];
  sessions: string[];
  // The open tracks of each session (added by tracks/new, removed by tracks/close), as GET /sessions/{id} shows them.
  tracks: Map<string, FakeTrack[]>;
  // Next answers: an HTTP status to fail with (Realtime outage or refusal), or null for the normal answer.
  failNext: number | null;
  // The same for the next PUT tracks/close only (the GET before it answers normally).
  failNextClose: number | null;
  // A Retry-After header for the next failed answer (failNext/failNextClose), or null for none.
  retryAfter: string | null;
  turnDown: boolean;
}

// Serves the Realtime and TURN APIs the way developers.cloudflare.com/realtime documents them.
export function fakeRealtime(stub: FetchStub): FakeRealtime {
  const fake: FakeRealtime = {
    requests: [],
    sessions: [],
    tracks: new Map(),
    failNext: null,
    failNextClose: null,
    retryAfter: null,
    turnDown: false,
  };
  let n = 0;
  stub.other = (url, init) => {
    if (!url.startsWith(`${REALTIME}/`)) return undefined;
    const path = url.slice(REALTIME.length);
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    fake.requests.push({ method, path, auth, body });
    const closing = method === "PUT" && path.endsWith("/tracks/close");
    const status = fake.failNext ?? (closing ? fake.failNextClose : null);
    if (status !== null) {
      if (fake.failNext !== null) fake.failNext = null;
      else fake.failNextClose = null;
      const headers: Record<string, string> = fake.retryAfter === null ? {} : { "retry-after": fake.retryAfter };
      fake.retryAfter = null;
      return Promise.resolve(
        Response.json({ errorCode: "fake_error", errorDescription: "fake refusal" }, { status, headers }),
      );
    }
    if (path.startsWith("/turn/")) {
      if (fake.turnDown) return Promise.resolve(new Response("down", { status: 503 }));
      return Promise.resolve(
        Response.json(
          {
            iceServers: [
              { urls: ["stun:stun.cloudflare.com:3478"] },
              {
                urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
                username: `user-${++n}`,
                credential: "fake-credential",
              },
            ],
          },
          { status: 201 },
        ),
      );
    }
    if (method === "POST" && /^\/apps\/[^/]+\/sessions\/new$/.test(path)) {
      const sessionId = `${(++n).toString(16).padStart(8, "0")}${"0".repeat(24)}`;
      fake.sessions.push(sessionId);
      return Promise.resolve(Response.json({ sessionId }, { status: 201 }));
    }
    const tracks = /^\/apps\/[^/]+\/sessions\/([^/]+)\/tracks\/(new|close)$/.exec(path);
    if (tracks) {
      const [, sessionId = "", action] = tracks;
      const open = fake.tracks.get(sessionId) ?? [];
      fake.tracks.set(sessionId, open);
      const requested = (body as { tracks?: Record<string, unknown>[] }).tracks ?? [];
      const answered = requested.map((t, i) => ({ ...t, mid: t.mid ?? String(open.length + i) }));
      if (action === "new") {
        for (const t of answered) open.push(t as unknown as FakeTrack);
      } else {
        const closed = new Set(answered.map((t) => t.mid));
        fake.tracks.set(
          sessionId,
          open.filter((t) => !closed.has(t.mid)),
        );
      }
      return Promise.resolve(
        Response.json({
          requiresImmediateRenegotiation: false,
          sessionDescription: { type: "answer", sdp: "v=0 fake answer" },
          tracks: answered,
        }),
      );
    }
    const session = /^\/apps\/[^/]+\/sessions\/([^/]+)$/.exec(path);
    if (method === "GET" && session) {
      const open = fake.tracks.get(session[1] ?? "");
      if (!fake.sessions.includes(session[1] ?? "")) {
        return Promise.resolve(Response.json({ errorCode: "not_found" }, { status: 404 }));
      }
      return Promise.resolve(Response.json({ tracks: (open ?? []).map((t) => ({ ...t, status: "active" })) }));
    }
    if (/^\/apps\/[^/]+\/sessions\/[^/]+\/renegotiate$/.test(path)) return Promise.resolve(Response.json({}));
    return Promise.resolve(Response.json({ errorCode: "not_found" }, { status: 404 }));
  };
  return fake;
}

let accounts = 0;

// A distinct account per call, so the per-account rate limits only matter in the rate limit test.
export function uniqueAccount(): string {
  return `account-${Date.now().toString(36)}-${++accounts}`;
}

export interface CallView {
  callId: string;
  conversationId: string;
  state: "ringing" | "active" | "ended";
  answeredAt: string | null;
  epoch: number;
  keyLeader: { accountId: string; deviceId: number } | null;
  participants: {
    accountId: string;
    deviceId: number;
    role: string;
    sessionId: string | null;
    tracks: string[];
    connected: boolean;
  }[];
  declined: string[];
  endReason: string | null;
}
