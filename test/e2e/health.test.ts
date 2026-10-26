// The API is up and answers as the contract says.
import { describe, expect, it } from "vitest";
import { api, LIVE } from "./base";

describe("health", () => {
  it("GET /health answers ok", async () => {
    const res = await api("/health");
    const text = await res.text();
    // The body in the message says whether the Worker (JSON) or Cloudflare's edge (HTML) answered.
    expect(res.status, `GET /health answered ${res.status}: ${text.slice(0, 300)}`).toBe(200);
    const body = JSON.parse(text) as { status: string; version: string };
    expect(body.status).toBe("ok");
    if (LIVE) expect(body.version).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it("unknown paths answer 404 JSON, never cached", async () => {
    const res = await api("/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
