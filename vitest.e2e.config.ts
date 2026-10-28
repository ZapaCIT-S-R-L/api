// End-to-end tests in Node against a running Worker: API_URL=http://127.0.0.1:8787 (wrangler dev) or the live
// staging API (API_URL=https://api-staging.zapakid.ro LIVE=1). global-setup.ts serves the test JWKS once for all
// files (127.0.0.1:8788).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    globalSetup: ["./test/e2e/global-setup.ts"],
  },
});
