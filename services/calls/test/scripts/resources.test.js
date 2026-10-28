// Tests for scripts/resources.js: the deploy finds the right EU database and queues, and patches only its environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findDatabase, names, patchConfig, PLACEHOLDERS } from "../../scripts/resources.js";

const UUID = "0123abcd-4567-89ef-0123-456789abcdef";

test("resource names per environment", () => {
  assert.deepEqual(names("staging"), {
    database: "zapakid-calls-staging",
    queues: ["zapakid-conversation-events-staging", "zapakid-conversation-events-staging-dlq"],
  });
  assert.equal(names("production").database, "zapakid-calls-production");
  assert.throws(() => names("local"));
  assert.throws(() => names("__proto__"));
});

test("refuses a database outside the EU, duplicates and bad uuids", () => {
  assert.throws(() => findDatabase([{ name: "x", uuid: UUID, jurisdiction: "us" }], "x"), /not "eu"/);
  assert.throws(() =>
    findDatabase(
      [
        { name: "x", uuid: UUID },
        { name: "x", uuid: UUID },
      ],
      "x",
    ),
  );
  assert.throws(() => findDatabase([{ name: "x", uuid: "nope" }], "x"));
  assert.equal(findDatabase([{ name: "x", uuid: UUID, jurisdiction: "eu" }], "x").uuid, UUID);
});

test("wrangler.jsonc has each placeholder exactly once, and patching touches only that environment", () => {
  const config = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
  const staging = patchConfig(config, "staging", UUID);
  assert.ok(staging.includes(UUID));
  assert.ok(staging.includes(PLACEHOLDERS.production));
  assert.throws(() => patchConfig(staging, "staging", UUID), /found 0/);
});
