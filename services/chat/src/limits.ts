// Per-account rate limits (Workers rate limiting bindings, limits per environment in wrangler.jsonc).
import { HttpError } from "./http";

export async function limit(limiter: RateLimit, key: string): Promise<void> {
  const { success } = await limiter.limit({ key });
  if (!success) {
    throw new HttpError(429, "rate_limited", "Too many requests. Try again in a minute.", {}, { "retry-after": "60" });
  }
}
