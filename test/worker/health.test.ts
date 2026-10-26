// The health check and the fallbacks every route shares.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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
