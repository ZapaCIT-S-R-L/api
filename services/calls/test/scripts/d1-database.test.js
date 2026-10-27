// Tests for scripts/d1-database.js: the deploy finds the right EU database and patches only its environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { databaseName, findDatabase, patchConfig, PLACEHOLDERS } from "../../scripts/d1-database.js";

const UUID = "0123abcd-4567-89ef-0123-456789abcdef";

test("database names per environment", () => {
  assert.equal(databaseName("staging"), "zapakid-calls-staging");
  assert.equal(databaseName("production"), "zapakid-calls-production");
  assert.throws(() => databaseName("local"));
  assert.throws(() => databaseName("__proto__"));
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
