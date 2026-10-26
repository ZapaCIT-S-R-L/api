// Unit and integration tests inside the Workers runtime (Miniflare), with local bindings from wrangler.jsonc.
// The D1 migrations are read here (Node) and applied by test/worker/setup.ts (Workers runtime).
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations },
        // A small auth rate limit, so test/worker/rate-limit.test.ts can reach it.
        ratelimits: { AUTH_LIMITER: { namespace_id: "9001", simple: { limit: 5, period: 60 } } },
      },
    }),
  ],
  test: { include: ["test/worker/**/*.test.ts"], setupFiles: ["./test/worker/setup.ts"] },
});
