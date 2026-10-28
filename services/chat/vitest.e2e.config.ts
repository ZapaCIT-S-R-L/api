// End-to-end tests in Node against a running chat Worker: CHAT_URL=http://127.0.0.1:8790 (wrangler dev, started by
// scripts/check.sh or the e2e job in ci-chat.yml) or the live staging service (CHAT_URL=https://chat-staging.zapakid.ro
// LIVE=1).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/e2e/**/*.test.ts"], environment: "node", testTimeout: 15_000, fileParallelism: false },
});
