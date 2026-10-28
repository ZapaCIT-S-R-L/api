// End-to-end tests in Node against a running calls Worker: CALLS_URL=http://127.0.0.1:8797 (wrangler dev, with the
// fake account JWKS and fake Realtime/TURN on 127.0.0.1:8798, see scripts/check.sh) or the live staging service
// (CALLS_URL=https://calls-staging.zapakid.ro LIVE=1).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    fileParallelism: false,
    globalSetup: ["./test/e2e/fakes.ts"],
  },
});
