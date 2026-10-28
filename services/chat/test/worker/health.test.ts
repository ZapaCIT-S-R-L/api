import { describe, expect, it } from "vitest";
import { call } from "./helpers";

describe("GET /health", () => {
  it("answers ok with the version, no auth needed", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: "dev" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("allows GET only", async () => {
    const res = await call("/health", { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("unknown paths are 404 JSON", async () => {
    const res = await call("/v1/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("the e2e hook doesn't exist off loopback", async () => {
    const res = await call("/__e2e/membership", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(404);
  });
});
