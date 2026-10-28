// The calls service is up and answers as the contract says.
import { describe, expect, it } from "vitest";
import { calls, LIVE } from "./base";

describe("health", () => {
  it("GET /health answers ok", async () => {
    const res = await calls("/health");
    const text = await res.text();
    expect(res.status, `GET /health answered ${res.status}: ${text.slice(0, 300)}`).toBe(200);
    const body = JSON.parse(text) as { status: string; version: string };
    expect(body.status).toBe("ok");
    if (LIVE) expect(body.version).toMatch(/^calls-[0-9a-f]{12}$/);
  });

  it("unknown paths answer 404 JSON, never cached", async () => {
    const res = await calls("/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
