import { test } from "node:test";
import assert from "node:assert/strict";
import { nextVersion } from "../../scripts/next-version.js";

test("first chat release is chat-v1.0.0; the account service's tags don't count", () => {
  assert.equal(nextVersion(["v1.0.7", "v2.0.0"], []), "chat-v1.0.0");
});

test("patch by default, minor and major by label", () => {
  const tags = ["chat-v1.2.3", "chat-v1.10.0", "v9.9.9"];
  assert.equal(nextVersion(tags, []), "chat-v1.10.1");
  assert.equal(nextVersion(tags, ["Minor"]), "chat-v1.11.0");
  assert.equal(nextVersion(tags, ["major", "minor"]), "chat-v2.0.0");
});
