// Applies the D1 migrations before each test file and empties the call log before each test.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM calls").run();
});
