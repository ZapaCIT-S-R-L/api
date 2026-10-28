// Applies the D1 migrations before each test file and empties the call log and the applied events before each test.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM calls"), env.DB.prepare("DELETE FROM processed_events")]);
});
