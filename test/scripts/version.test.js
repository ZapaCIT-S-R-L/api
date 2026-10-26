// Tests for scripts/next-version.js: the release tag each deploy creates (vMAJOR.MINOR.PATCH).
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextVersion } from "../../scripts/next-version.js";

const cases = [
  [[], [], "v1.0.0", "first release"],
  [["v1.0.0"], [], "v1.0.1", "patch by default"],
  [["v1.0.9"], ["documentation"], "v1.0.10", "unrelated labels still mean patch"],
  [["v1.0.4"], ["minor"], "v1.1.0", "minor label: large feature, patch resets"],
  [["v1.3.7"], ["major"], "v2.0.0", "major label: breaking change, minor and patch reset"],
  [["v1.3.7"], ["minor", "major"], "v2.0.0", "major wins over minor"],
  [["v1.2.0", "v1.10.0", "v1.9.3"], [], "v1.10.1", "highest version by number, not by text"],
  [["v1.0.2", "archive-site-2026-10-19", "v2", "1.0.5", "v1.0.3-rc1"], [], "v1.0.3", "ignores non-release tags"],
  [["v1.0.0"], ["MINOR"], "v1.1.0", "labels are case-insensitive"],
];

for (const [tags, labels, expected, why] of cases) {
  test(`${JSON.stringify(tags)} + ${JSON.stringify(labels)} -> ${expected} (${why})`, () => {
    assert.equal(nextVersion(tags, labels), expected);
  });
}
