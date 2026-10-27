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
        // Fake Realtime and TURN credentials: the tests serve those APIs themselves (test/worker/helpers.ts).
        bindings: {
          TEST_MIGRATIONS: migrations,
          REALTIME_APP_ID: "test-app-id",
          REALTIME_APP_SECRET: "test-app-secret",
          TURN_KEY_ID: "test-turn-key",
          TURN_KEY_API_TOKEN: "test-turn-token",
        },
        // A small create limit, so test/worker/calls.test.ts can reach it (counted per account).
        ratelimits: {
          CREATE_LIMITER: { namespace_id: "9101", simple: { limit: 5, period: 60 } },
          JOIN_LIMITER: { namespace_id: "9102", simple: { limit: 100, period: 60 } },
        },
      },
    }),
  ],
  test: { include: ["test/worker/**/*.test.ts"], setupFiles: ["./test/worker/setup.ts"] },
});
