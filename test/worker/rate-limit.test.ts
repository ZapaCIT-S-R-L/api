// Rate limiting on the unauthenticated auth endpoints (nonce, Apple, Google sign-in): per client IP, per
// Cloudflare location, via the Workers rate limiting binding. The tests run with a limit of 5 per minute
// (vitest.config.ts); staging and production use the values in wrangler.jsonc.
import { describe, expect, it } from "vitest";
import { ADULT, call, type ErrorBody } from "./helpers";

const TEST_LIMIT = 5;

const fromIp = (ip: string, path: string, body?: unknown) =>
  call(path, {
    method: "POST",
    headers: { "cf-connecting-ip": ip, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("auth rate limit", () => {
  it("allows the limit, then answers 429 rate_limited with Retry-After", async () => {
    const ip = "198.51.100.7";
    for (let i = 0; i < TEST_LIMIT; i++) expect((await fromIp(ip, "/v1/auth/nonce")).status).toBe(200);
    const res = await fromIp(ip, "/v1/auth/nonce");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect((await res.json<ErrorBody>()).error.code).toBe("rate_limited");
  });

  it("counts nonce and sign-in requests together", async () => {
    const ip = "198.51.100.8";
    for (let i = 0; i < TEST_LIMIT; i++) await fromIp(ip, "/v1/auth/nonce");
    const apple = await fromIp(ip, "/v1/auth/apple", {
      identityToken: "a.b.c",
      ageRange: ADULT,
      nonce: "A".repeat(43),
    });
    expect(apple.status).toBe(429);
    const google = await fromIp(ip, "/v1/auth/google", { idToken: "a.b.c", ageRange: ADULT, nonce: "A".repeat(43) });
    expect(google.status).toBe(429);
  });

  it("rejects before reading the body or the token", async () => {
    const ip = "198.51.100.9";
    for (let i = 0; i < TEST_LIMIT; i++) await fromIp(ip, "/v1/auth/nonce");
    expect((await fromIp(ip, "/v1/auth/apple", "not json")).status).toBe(429);
  });

  it("other IPs are not affected", async () => {
    const ip = "198.51.100.10";
    for (let i = 0; i < TEST_LIMIT + 1; i++) await fromIp(ip, "/v1/auth/nonce");
    expect((await fromIp("198.51.100.11", "/v1/auth/nonce")).status).toBe(200);
  });

  it("IPv6 addresses in the same /64 share a limit", async () => {
    for (let i = 0; i < TEST_LIMIT; i++) await fromIp(`2001:db8:1:2::${(i + 1).toString(16)}`, "/v1/auth/nonce");
    expect((await fromIp("2001:db8:1:2:ffff:ffff:ffff:ffff", "/v1/auth/nonce")).status).toBe(429);
    expect((await fromIp("2001:db8:1:3::1", "/v1/auth/nonce")).status).toBe(200);
  });

  it("signed-in endpoints and health are not limited by it", async () => {
    const ip = "198.51.100.12";
    for (let i = 0; i < TEST_LIMIT + 1; i++) await fromIp(ip, "/v1/auth/nonce");
    expect((await call("/health", { headers: { "cf-connecting-ip": ip } })).status).toBe(200);
    expect((await call("/v1/me", { headers: { "cf-connecting-ip": ip } })).status).toBe(401);
  });
});
