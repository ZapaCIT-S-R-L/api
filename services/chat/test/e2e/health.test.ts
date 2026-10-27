import { describe, expect, it } from "vitest";
import { chat, LIVE } from "./base";

describe("GET /health", () => {
  it("is ok and reports the version", async () => {
    const res = await chat("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string };
    expect(body.status).toBe("ok");
    if (LIVE && process.env.VERSION) expect(body.version).toBe(process.env.VERSION);
  });

  it.runIf(LIVE)("the test hook doesn't exist when deployed", async () => {
    const res = await chat("/__e2e/membership", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });
});
