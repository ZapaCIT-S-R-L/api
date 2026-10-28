// Unit and integration tests inside the Workers runtime (Miniflare), with local bindings from wrangler.jsonc.
// The D1 migrations are read here (Node) and applied by test/worker/setup.ts (Workers runtime).
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

// A throwaway chat token signing key for this test run (the real ones are Worker secrets, never in git).
const { privateKey } = await generateKeyPair("ES256", { extractable: true });
const privateJwk = await exportJWK(privateKey);
const chatTokenKey = JSON.stringify({
  ...privateJwk,
  kid: await calculateJwkThumbprint(privateJwk),
  alg: "ES256",
  use: "sig",
});

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations, CHAT_TOKEN_SIGNING_KEY: chatTokenKey },
        // A small auth rate limit, so test/worker/rate-limit.test.ts can reach it.
        ratelimits: { AUTH_LIMITER: { namespace_id: "9001", simple: { limit: 5, period: 60 } } },
      },
    }),
  ],
  test: { include: ["test/worker/**/*.test.ts"], setupFiles: ["./test/worker/setup.ts"] },
});
