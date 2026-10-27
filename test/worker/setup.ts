// Applies the D1 migrations before each test file and empties the tables before each test, so every test starts
// from an empty database and one fresh sign-in nonce (see helpers.ts).
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";
import { primeNonce } from "./helpers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(async () => {
  await env.DB.batch(
    [
      "sessions",
      "parent_identities",
      "parents",
      "sign_in_nonces",
      "apple_web_flows",
      "app_attest_challenges",
      "app_attest_keys",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  await primeNonce();
});
