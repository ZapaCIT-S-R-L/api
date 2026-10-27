// The health check and the fallbacks every route shares.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";

const call = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`https://calls.test${path}`, init));

describe("GET /health", () => {
  it("answers ok with the version, never cached", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: "dev" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses other methods", async () => {
    const res = await call("/health", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});

describe("unknown paths", () => {
  it("answer 404 as JSON", async () => {
    const res = await call("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "No such endpoint." } });
  });
});

describe("GET /health with missing or unsafe config", () => {
  const health = (overrides: Record<string, unknown>) =>
    worker.fetch(new Request("https://calls.test/health"), {
      ...env,
      ...overrides,
    });

  const cases: [string, Record<string, unknown>, string][] = [
    ["no D1 binding", { DB: undefined }, "DB binding missing"],
    ["a plain-http JWKS URL off loopback", { ACCOUNT_JWKS_URL: "http://api.example/jwks" }, "ACCOUNT_JWKS_URL"],
    ["no JWKS URL", { ACCOUNT_JWKS_URL: "" }, "ACCOUNT_JWKS_URL"],
    ["no issuer", { TOKEN_ISSUER: "" }, "TOKEN_ISSUER"],
    ["no audience", { TOKEN_AUDIENCE: "" }, "TOKEN_AUDIENCE"],
    ["no Durable Object binding", { CALL: undefined }, "CALL binding missing"],
    ["no rate limiter", { JOIN_LIMITER: undefined }, "JOIN_LIMITER binding missing"],
    ["no Realtime app id", { REALTIME_APP_ID: undefined }, "REALTIME_APP_ID missing"],
    ["no Realtime app secret", { REALTIME_APP_SECRET: "" }, "REALTIME_APP_SECRET missing"],
    ["no TURN key", { TURN_KEY_ID: undefined }, "TURN_KEY_ID missing"],
    ["no TURN token", { TURN_KEY_API_TOKEN: undefined }, "TURN_KEY_API_TOKEN missing"],
    ["a plain-http Realtime URL", { REALTIME_API_URL: "http://rtc.example/v1" }, "REALTIME_API_URL"],
    ["more than 8 participants", { MAX_PARTICIPANTS: "50" }, "MAX_PARTICIPANTS"],
    ["TURN credentials over an hour", { TURN_TTL_SECONDS: "86400" }, "TURN_TTL_SECONDS"],
  ];
  for (const [why, overrides, name] of cases) {
    it(`${why} → 503 misconfigured, naming ${name}`, async () => {
      const res = await health(overrides);
      expect(res.status).toBe(503);
      const body = await res.json<{ status: string; problems: string[] }>();
      expect(body.status).toBe("misconfigured");
      expect(body.problems.join("\n")).toContain(name);
    });
  }
});
