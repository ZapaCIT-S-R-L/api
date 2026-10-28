import { describe, expect, it } from "vitest";
import { HttpError } from "../../src/http";
import { limit } from "../../src/limits";

describe("rate limits", () => {
  it("over the limit: 429 rate_limited with Retry-After", async () => {
    const limiter = { limit: () => Promise.resolve({ success: false }) } as unknown as RateLimit;
    const error = await limit(limiter, "send:a:1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    const res = (error as HttpError).response();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toMatchObject({ error: { code: "rate_limited" } });
  });

  it("under the limit: passes", async () => {
    const limiter = { limit: () => Promise.resolve({ success: true }) } as unknown as RateLimit;
    await expect(limit(limiter, "k")).resolves.toBeUndefined();
  });
});
