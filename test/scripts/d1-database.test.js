// Tests for scripts/d1-database.js: the deploy finds the right EU database and patches only its environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { databaseName, findDatabase, patchConfig, PLACEHOLDERS } from "../../scripts/d1-database.js";

const UUID = "0123abcd-4567-89ef-0123-456789abcdef";

test("database names per environment", () => {
  assert.equal(databaseName("staging"), "zapakid-api-staging");
  assert.equal(databaseName("production"), "zapakid-api-production");
  assert.throws(() => databaseName("local"));
  assert.throws(() => databaseName("__proto__"));
});

test("finds the database by exact name", () => {
  const list = [
    { name: "zapakid-api-staging-old", uuid: "11111111-1111-1111-1111-111111111111" },
    { name: "zapakid-api-staging", uuid: UUID, jurisdiction: "eu" },
  ];
  assert.equal(findDatabase(list, "zapakid-api-staging").uuid, UUID);
  assert.equal(findDatabase(list, "zapakid-api-production"), null);
});

test("refuses a database outside the EU", () => {
  assert.throws(() => findDatabase([{ name: "x", uuid: UUID, jurisdiction: "us" }], "x"), /not "eu"/);
});

test("refuses duplicates and bad uuids", () => {
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
});

test("wrangler.jsonc has each placeholder exactly once, and patching touches only that environment", () => {
  const config = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
  const staging = patchConfig(config, "staging", UUID);
  assert.ok(staging.includes(UUID));
  assert.ok(staging.includes(PLACEHOLDERS.production));
  assert.ok(staging.includes("00000000-0000-0000-0000-000000000000"));
  assert.throws(() => patchConfig(staging, "staging", UUID), /found 0/);
});
