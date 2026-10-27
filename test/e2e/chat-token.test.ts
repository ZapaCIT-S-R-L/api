// The chat token issuer over HTTP. Locally wrangler dev runs with a throwaway signing key (ci.yml, check.sh);
// deployed environments use the key Stefan set (scripts/set-chat-token-key.sh).
import { describe, expect, it } from "vitest";
import { api, bodyOf } from "./base";

describe("chat token", () => {
  it("GET /.well-known/jwks.json publishes one public ES256 key", async () => {
    const res = await api("/.well-known/jwks.json");
    expect(res.status, "set CHAT_TOKEN_SIGNING_KEY (scripts/set-chat-token-key.sh)").toBe(200);
    const { keys } = await bodyOf<{ keys: Record<string, unknown>[] }>(res);
    expect(keys.length).toBeGreaterThanOrEqual(1);
    for (const key of keys) {
      expect(key).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
      expect(key).not.toHaveProperty("d");
    }
  });

  it("POST /v1/chat/token without a session → 401", async () => {
    const res = await api("/v1/chat/token", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });
});
