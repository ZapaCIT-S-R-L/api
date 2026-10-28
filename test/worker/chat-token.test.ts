// POST /v1/chat/token and GET /.well-known/jwks.json: the short-lived ES256 token the chat and calls services
// accept instead of a session. The signing key is generated per test run (vitest.config.ts), never committed.
import { env } from "cloudflare:workers";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { useMembershipSource, type MembershipSource } from "../../src/membership";
import {
  ADULT,
  appleClaims,
  bearer,
  call,
  makeIssuer,
  postJson,
  resetJwksCache,
  stubJwks,
  workerRequest,
  type ErrorBody,
  type SignInBody,
  type TestIssuer,
} from "./helpers";

const ISSUER = "http://localhost:8787";
const AUDIENCES = ["chat.localhost", "calls.localhost"];

let apple: TestIssuer;

// Seeded membership data: the tables behind it (devices, families, conversations) arrive in later PRs.
const seeded: { devices: Map<string, number>; conversations: Map<string, string[]> } = {
  devices: new Map(),
  conversations: new Map(),
};
const seededSource: MembershipSource = {
  device: (_env, session) => Promise.resolve(seeded.devices.get(session.parentId) ?? null),
  conversations: (_env, accountId) => Promise.resolve(seeded.conversations.get(accountId) ?? []),
};

beforeEach(async () => {
  resetJwksCache();
  apple = await makeIssuer();
  stubJwks([apple], []);
  seeded.devices.clear();
  seeded.conversations.clear();
  useMembershipSource(seededSource);
});

afterEach(() => {
  useMembershipSource(null);
  vi.restoreAllMocks();
});

async function signIn(sub = "parent-1"): Promise<SignInBody> {
  const res = await postJson("/v1/auth/apple", {
    identityToken: await apple.sign(appleClaims({ sub })),
    ageRange: ADULT,
    displayName: "Ana",
  });
  expect(res.status).toBe(200);
  return await res.json<SignInBody>();
}

async function jwks(): Promise<JSONWebKeySet> {
  const res = await call("/.well-known/jwks.json");
  expect(res.status).toBe(200);
  return await res.json<JSONWebKeySet>();
}

const token = (session: string) => call("/v1/chat/token", { method: "POST", headers: bearer(session) });

describe("GET /.well-known/jwks.json", () => {
  it("publishes the public ES256 key only", async () => {
    const res = await call("/.well-known/jwks.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const { keys } = await res.json<JSONWebKeySet>();
    expect(keys).toHaveLength(1);
    const [key] = keys;
    expect(key).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    expect(key?.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key).not.toHaveProperty("d");
  });

  it("needs no session", async () => {
    expect((await call("/.well-known/jwks.json")).status).toBe(200);
  });

  it("without the signing key → 503 not_configured", async () => {
    const res = await worker.fetch(workerRequest("https://api.test/.well-known/jwks.json"), {
      ...env,
      CHAT_TOKEN_SIGNING_KEY: undefined,
    });
    expect(res.status).toBe(503);
    expect((await res.json<ErrorBody>()).error.code).toBe("not_configured");
  });

  it("POST → 405", async () => {
    expect((await call("/.well-known/jwks.json", { method: "POST" })).status).toBe(405);
  });
});

describe("POST /v1/chat/token", () => {
  it("issues an ES256 token for chat and calls, at most 15 minutes, with the account's device and conversations", async () => {
    const { session, parent } = await signIn();
    seeded.devices.set(parent.id, 3);
    seeded.conversations.set(parent.id, ["conv-a", "conv-b"]);
    const res = await token(session.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json<{ token: string; expiresAt: string }>();
    expect(decodeProtectedHeader(body.token)).toMatchObject({ alg: "ES256", typ: "JWT" });

    const { payload } = await jwtVerify(body.token, createLocalJWKSet(await jwks()), {
      algorithms: ["ES256"],
      issuer: ISSUER,
      audience: "calls.localhost",
    });
    expect(payload.aud).toEqual(AUDIENCES);
    expect(payload.sub).toBe(parent.id);
    expect(payload.dev).toBe(3);
    expect(payload.role).toBe("parent");
    expect(payload.conv).toEqual(["conv-a", "conv-b"]);
    expect(payload.sep).toBe(0);
    expect(payload.jti).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    const lifetime = (payload.exp ?? 0) - (payload.iat ?? 0);
    expect(lifetime).toBe(600);
    expect(lifetime).toBeLessThanOrEqual(900);
    expect(Date.parse(body.expiresAt)).toBe((payload.exp ?? 0) * 1000);
  });

  it("only the caller's own conversations", async () => {
    const a = await signIn("parent-a");
    const b = await signIn("parent-b");
    seeded.devices.set(a.parent.id, 1);
    seeded.conversations.set(a.parent.id, ["conv-a"]);
    seeded.conversations.set(b.parent.id, ["conv-b"]);
    const { token: jwt } = await (await token(a.session.token)).json<{ token: string }>();
    const { payload } = await jwtVerify(jwt, createLocalJWKSet(await jwks()), { audience: "chat.localhost" });
    expect(payload.conv).toEqual(["conv-a"]);
  });

  it("an account in no conversation gets an empty list", async () => {
    const { session, parent } = await signIn();
    seeded.devices.set(parent.id, 1);
    const { token: jwt } = await (await token(session.token)).json<{ token: string }>();
    const { payload } = await jwtVerify(jwt, createLocalJWKSet(await jwks()), { audience: "chat.localhost" });
    expect(payload.conv).toEqual([]);
  });

  it("a session without a registered device → 409 device_required", async () => {
    const { session } = await signIn();
    const res = await token(session.token);
    expect(res.status).toBe(409);
    expect((await res.json<ErrorBody>()).error.code).toBe("device_required");
  });

  it("by default (no membership data yet) every session is refused with device_required", async () => {
    useMembershipSource(null);
    const { session } = await signIn();
    expect((await token(session.token)).status).toBe(409);
  });

  it("without a session → 401", async () => {
    const res = await call("/v1/chat/token", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  // api #81: the chat and calls services refuse tokens with a `sep` below the parent's current epoch.
  it("carries the parent's session epoch (sep), which logout-all increments", async () => {
    const { session, parent } = await signIn();
    seeded.devices.set(parent.id, 1);
    await call("/v1/auth/logout-all", { method: "POST", headers: bearer(session.token) });
    expect((await token(session.token)).status).toBe(401);
    const again = await signIn();
    const { token: jwt } = await (await token(again.session.token)).json<{ token: string }>();
    const { payload } = await jwtVerify(jwt, createLocalJWKSet(await jwks()), { audience: "chat.localhost" });
    expect(payload.sep).toBe(1);
  });

  it("after logout → 401", async () => {
    const { session, parent } = await signIn();
    seeded.devices.set(parent.id, 1);
    await call("/v1/auth/logout", { method: "POST", headers: bearer(session.token) });
    expect((await token(session.token)).status).toBe(401);
  });

  it("without the signing key → 503 not_configured", async () => {
    const { session, parent } = await signIn();
    seeded.devices.set(parent.id, 1);
    const res = await worker.fetch(
      workerRequest("https://api.test/v1/chat/token", { method: "POST", headers: bearer(session.token) }),
      { ...env, CHAT_TOKEN_SIGNING_KEY: undefined },
    );
    expect(res.status).toBe(503);
    expect((await res.json<ErrorBody>()).error.code).toBe("not_configured");
  });

  it("a TTL over 15 minutes is refused (server error, never a long token)", async () => {
    const { session, parent } = await signIn();
    seeded.devices.set(parent.id, 1);
    const res = await worker.fetch(
      workerRequest("https://api.test/v1/chat/token", { method: "POST", headers: bearer(session.token) }),
      { ...env, CHAT_TOKEN_TTL_SECONDS: "901" },
    );
    expect(res.status).toBe(500);
  });

  it("GET → 405", async () => {
    expect((await call("/v1/chat/token")).status).toBe(405);
  });
});

describe("GET /health and the chat token config", () => {
  const health = (overrides: Record<string, unknown>) =>
    worker.fetch(workerRequest("https://api.test/health"), { ...env, ...overrides });

  it("a missing key is not a health problem (chat and calls answer 503 until it is set)", async () => {
    expect((await health({ CHAT_TOKEN_SIGNING_KEY: undefined })).status).toBe(200);
  });

  for (const [why, overrides, problem] of [
    [
      "a key that is not a private P-256 JWK",
      { CHAT_TOKEN_SIGNING_KEY: '{"kty":"oct","k":"x"}' },
      "CHAT_TOKEN_SIGNING_KEY invalid",
    ],
    ["not JSON", { CHAT_TOKEN_SIGNING_KEY: "not json" }, "CHAT_TOKEN_SIGNING_KEY invalid"],
    [
      "a public key only",
      { CHAT_TOKEN_SIGNING_KEY: JSON.stringify({ ...JSON.parse(env.CHAT_TOKEN_SIGNING_KEY ?? "{}"), d: undefined }) },
      "CHAT_TOKEN_SIGNING_KEY invalid",
    ],
    ["no issuer", { CHAT_TOKEN_ISSUER: "" }, "CHAT_TOKEN_ISSUER not an http(s) URL"],
    ["no audiences", { CHAT_TOKEN_AUDIENCES: " " }, "CHAT_TOKEN_AUDIENCES empty"],
    ["a TTL over 15 minutes", { CHAT_TOKEN_TTL_SECONDS: "3600" }, "CHAT_TOKEN_TTL_SECONDS invalid"],
  ] as const) {
    it(`${why} → 503 naming it`, async () => {
      const res = await health(overrides);
      expect(res.status).toBe(503);
      expect((await res.json<{ problems: string[] }>()).problems).toContain(problem);
    });
  }
});
