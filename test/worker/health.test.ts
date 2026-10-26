// The health check and the fallbacks every route shares.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";

const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`https://api.test${path}`, init));

describe("GET /health", () => {
  it("answers ok with the version", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: "dev" });
  });

  it("is never cached and sends the security headers", async () => {
    const res = await call("/health");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
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

// Config checks: /health says what is missing (names only, never values) instead of failing later.
describe("GET /health with missing config", () => {
  const health = (overrides: Record<string, unknown>) =>
    worker.fetch(new Request("https://api.test/health"), {
      ...env,
      ...overrides,
    });

  it("all config present → 200 ok", async () => {
    expect((await health({})).status).toBe(200);
  });

  const cases: [string, Record<string, unknown>, string][] = [
    ["no D1 binding", { DB: undefined }, "DB"],
    ["no rate limiter", { AUTH_LIMITER: undefined }, "AUTH_LIMITER"],
    ["no Apple audience", { APPLE_AUDIENCES: "" }, "APPLE_AUDIENCES"],
    ["bad Apple redirect", { APPLE_WEB_REDIRECT_URL: "http://evil.example/app" }, "APPLE_WEB_REDIRECT_URL"],
    ["bad session TTL", { SESSION_TTL_SECONDS: "forever" }, "SESSION_TTL_SECONDS"],
  ];
  for (const [why, overrides, name] of cases) {
    it(`${why} → 503 misconfigured, naming ${name}`, async () => {
      const res = await health(overrides);
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json<{ status: string; version: string; problems: string[] }>();
      expect(body.status).toBe("misconfigured");
      expect(body.version).toBe("dev");
      expect(body.problems.join(" ")).toContain(name);
    });
  }

  it("never echoes config values", async () => {
    const res = await health({ APPLE_WEB_REDIRECT_URL: "http://secret-value.example", SESSION_TTL_SECONDS: "s3cr3t" });
    const text = await res.text();
    expect(text).not.toContain("secret-value");
    expect(text).not.toContain("s3cr3t");
  });

  it("Google sign-in off (no client ids yet) is not a problem", async () => {
    expect((await health({ GOOGLE_CLIENT_IDS: "" })).status).toBe(200);
  });

  it("an unreachable database → 503 naming DB", async () => {
    const broken = { prepare: () => ({ first: () => Promise.reject(new Error("D1 down")) }) };
    const res = await health({ DB: broken });
    expect(res.status).toBe(503);
    expect((await res.json<{ problems: string[] }>()).problems.join(" ")).toContain("DB");
  });
});
