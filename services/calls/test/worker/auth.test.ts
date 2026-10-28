// Chat token checks: calls has no login of its own and trusts only short-lived ES256 tokens from the account API.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticate, InvalidToken } from "../../src/auth";
import { KeysUnavailable, resetJwksCache } from "../../src/jwks";
import { bearer, chatClaims, makeIssuer, stubFetch, type FetchStub, type TestIssuer } from "./helpers";

let issuer: TestIssuer;
let stub: FetchStub;

beforeEach(async () => {
  resetJwksCache();
  issuer = await makeIssuer();
  stub = stubFetch([issuer]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const request = (headers: Record<string, string> = {}) => new Request("https://calls.test/v1/calls", { headers });
const check = async (token: string) => authenticate(request(bearer(token)), env);
const rejects = async (token: string, reason: RegExp) => {
  await expect(check(token)).rejects.toThrow(InvalidToken);
  await expect(check(token)).rejects.toThrow(reason);
};

describe("authenticate", () => {
  it("accepts a chat token from the account API for this host", async () => {
    const caller = await check(await issuer.sign(chatClaims({ conv: ["family:f1", "connection:k2"], dev: 7 })));
    expect(caller).toEqual({
      accountId: "account-1",
      deviceId: 7,
      role: "parent",
      scopes: ["family:f1", "connection:k2"],
      sep: 0,
    });
  });

  // api #81: the session epoch claim, which the chat service compares with the account's current one.
  it("reads the sep claim (0 when missing); a malformed one is invalid", async () => {
    expect((await check(await issuer.sign(chatClaims({ sep: 3 })))).sep).toBe(3);
    expect((await check(await issuer.sign(chatClaims()))).sep).toBe(0);
    for (const sep of [-1, 1.5, "1", null]) await rejects(await issuer.sign(chatClaims({ sep })), /sep/);
  });

  it("accepts a kid's token", async () => {
    expect((await check(await issuer.sign(chatClaims({ role: "kid" })))).role).toBe("kid");
  });

  it("caches the key set (one fetch for many tokens)", async () => {
    for (let i = 0; i < 3; i++) await check(await issuer.sign(chatClaims()));
    expect(stub.jwksCalls).toBe(1);
  });

  it("no or a malformed Authorization header → invalid", async () => {
    await expect(authenticate(request(), env)).rejects.toThrow(InvalidToken);
    const token = await issuer.sign(chatClaims());
    for (const authorization of [token, `Basic ${token}`, "Bearer", `Bearer ${token} x`]) {
      await expect(authenticate(request({ authorization }), env)).rejects.toThrow(InvalidToken);
    }
  });

  it("a token for chat only (wrong audience) → invalid", async () => {
    await rejects(await issuer.sign(chatClaims({ aud: ["chat.localhost"] })), /aud/);
  });

  it("a token from another issuer → invalid", async () => {
    await rejects(await issuer.sign(chatClaims({ iss: "https://evil.example" })), /iss/);
  });

  it("an expired token → invalid", async () => {
    const iat = Math.floor(Date.now() / 1000) - 1000;
    await rejects(await issuer.sign(chatClaims(), { iat, ttl: 600 }), /exp/);
  });

  it("a token living longer than 15 minutes → invalid, even if not expired yet", async () => {
    await rejects(await issuer.sign(chatClaims(), { ttl: 3600 }), /lifetime/);
  });

  it("a token signed by an unknown key → invalid, after one refetch at most", async () => {
    const stranger = await makeIssuer("stranger");
    await rejects(await stranger.sign(chatClaims()), /signature|key/);
    expect(stub.jwksCalls).toBeLessThanOrEqual(2);
  });

  it("a key the account API rotated in is picked up (unknown kid refetches after the cooldown)", async () => {
    await check(await issuer.sign(chatClaims()));
    const next = await makeIssuer("rotated");
    stub.keys = [next.jwk];
    vi.useFakeTimers({ now: Date.now() + 6 * 60 * 1000, toFake: ["Date"] });
    try {
      expect((await check(await next.sign(chatClaims()))).accountId).toBe("account-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unsigned token (alg none) → invalid", async () => {
    const header = btoa(JSON.stringify({ alg: "none", kid: issuer.kid })).replace(/=+$/, "");
    const body = btoa(JSON.stringify(chatClaims({ exp: Math.floor(Date.now() / 1000) + 60 }))).replace(/=+$/, "");
    await rejects(`${header}.${body}.`, /.+/);
  });

  for (const [why, overrides] of [
    ["no subject", { sub: undefined }],
    ["no device", { dev: undefined }],
    ["a device id that is not 1-127", { dev: 0 }],
    ["a device id that is a string", { dev: "1" }],
    ["an unknown role", { role: "admin" }],
    ["conversations that are not a list", { conv: "conv-1" }],
    ["a conversation id that is not a string", { conv: [1] }],
  ] as const) {
    it(`${why} → invalid`, async () => {
      await rejects(await issuer.sign(chatClaims(overrides)), /claim/);
    });
  }

  it("the account API's keys unreachable → KeysUnavailable (503 to the app, not 401)", async () => {
    stub.failJwks = true;
    await expect(check(await issuer.sign(chatClaims()))).rejects.toThrow(KeysUnavailable);
  });
});
