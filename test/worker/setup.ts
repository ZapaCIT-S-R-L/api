// Applies the D1 migrations before each test file and empties the tables before each test, so every test starts
// from an empty database.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(async () => {
  await env.DB.batch(
    ["sessions", "parent_identities", "parents"].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
});
