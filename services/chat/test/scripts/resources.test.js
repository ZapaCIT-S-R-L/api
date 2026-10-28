import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findDatabase, names, patchConfig, PLACEHOLDERS } from "../../scripts/resources.js";

const UUID = "0123abcd-0000-4000-8000-0123456789ab";

test("resource names per environment", () => {
  assert.deepEqual(names("staging"), {
    database: "zapakid-chat-staging",
    bucket: "zapakid-chat-attachments-staging",
    queues: ["zapakid-membership-staging", "zapakid-membership-staging-dlq"],
  });
  assert.throws(() => names("dev"));
});

test("findDatabase: by name, EU only, valid uuid", () => {
  assert.equal(findDatabase([], "zapakid-chat-staging"), null);
  assert.equal(
    findDatabase([{ name: "zapakid-chat-staging", uuid: UUID, jurisdiction: "eu" }], "zapakid-chat-staging").uuid,
    UUID,
  );
  assert.throws(() => findDatabase([{ name: "x", uuid: UUID, jurisdiction: "fedramp" }], "x"), /not "eu"/);
  assert.throws(() => findDatabase([{ name: "x", uuid: "nope" }], "x"), /uuid/);
  assert.throws(
    () =>
      findDatabase(
        [
          { name: "x", uuid: UUID },
          { name: "x", uuid: UUID },
        ],
        "x",
      ),
    /more than one/,
  );
});

test("patchConfig replaces exactly the environment's placeholder in wrangler.jsonc", () => {
  const text = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
  for (const env of ["staging", "production"]) {
    const patched = patchConfig(text, env, UUID);
    assert.ok(patched.includes(UUID));
    assert.ok(!patched.includes(PLACEHOLDERS[env]));
  }
  assert.throws(() => patchConfig("{}", "staging", UUID));
});
