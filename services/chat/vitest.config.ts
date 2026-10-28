// Unit and integration tests inside the Workers runtime (Miniflare), with the local bindings from wrangler.jsonc.
// The D1 migrations are read here (Node) and applied by test/worker/setup.ts (Workers runtime).
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: { include: ["test/worker/**/*.test.ts"], setupFiles: ["./test/worker/setup.ts"] },
});
