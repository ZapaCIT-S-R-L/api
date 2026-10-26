// The API is up and answers as the contract says.
import { describe, expect, it } from "vitest";
import { api, bodyOf, LIVE } from "./base";

describe("health", () => {
  it("GET /health answers ok", async () => {
    const res = await api("/health");
    expect(res.status).toBe(200);
    const body = await bodyOf<{ status: string; version: string }>(res);
    expect(body.status).toBe("ok");
    if (LIVE) expect(body.version).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it("unknown paths answer 404 JSON, never cached", async () => {
    const res = await api("/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
