// Unit and integration tests inside the Workers runtime (Miniflare), with local bindings from wrangler.jsonc.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { include: ["test/worker/**/*.test.ts"] },
});
