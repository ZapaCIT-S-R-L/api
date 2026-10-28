// Applies the D1 migrations before each test file and empties the tables before each test.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";
import { resetJwksCache } from "../../src/jwks";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const TABLES = [
  "attachments",
  "attachment_downloads",
  "conversation_members",
  "conversations",
  "family_members",
  "connections",
  "shared_kids",
  "devices",
  "session_epochs",
  "processed_events",
  "conversation_outbox",
];

beforeEach(async () => {
  resetJwksCache();
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
});

afterEach(() => {
  vi.restoreAllMocks();
});
