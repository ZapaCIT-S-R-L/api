// Tests for scripts/cla-check.js: may this pull request author's contribution be merged under the CLA?
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasSigned } from "../../scripts/cla-check.js";

const signatures = `# CLA signatures

| GitHub | Name | Date | CLA version |
| --- | --- | --- | --- |
| @jane-doe | Jane Doe | 2026-11-02 | 1 |
| @Ion_Pop | Ion Pop | 2026-11-03 | 1 |
`;

const cases = [
  ["jane-doe", "CONTRIBUTOR", true, "listed contributor"],
  ["ion_pop", "FIRST_TIME_CONTRIBUTOR", true, "listed, username case differs"],
  ["mallory", "FIRST_TIME_CONTRIBUTOR", false, "not listed"],
  ["jane", "CONTRIBUTOR", false, "a prefix of a listed username doesn't count"],
  ["Jane Doe", "NONE", false, "a name is not a username"],
  ["stefan-zpc", "OWNER", true, "org owner"],
  ["someone", "MEMBER", true, "org member"],
  ["dependabot[bot]", "NONE", true, "bots"],
  ["github-actions[bot]", "NONE", true, "bots"],
  ["mallory", "COLLABORATOR", false, "outside collaborators still sign"],
];

for (const [login, association, expected, why] of cases) {
  test(`${login} (${association}) -> ${expected ? "signed" : "must sign"} (${why})`, () => {
    assert.equal(hasSigned(login, association, signatures), expected);
  });
}

test("a username mentioned outside the table doesn't count", () => {
  assert.equal(hasSigned("mallory", "NONE", signatures + "\nThanks @mallory for the review.\n"), false);
});

// GitHub reports org members with private membership as CONTRIBUTOR, so staff come from CODEOWNERS on main.
const codeowners = "# Every change needs approval from a code owner.\n* @stefan-zpc\n/docs/ @Some-Maintainer\n";

test("a code owner on main is staff, whatever GitHub reports", () => {
  assert.equal(hasSigned("stefan-zpc", "CONTRIBUTOR", signatures, codeowners), true);
  assert.equal(hasSigned("some-maintainer", "NONE", signatures, codeowners), true);
});

test("a username in a CODEOWNERS comment is not staff", () => {
  assert.equal(hasSigned("every", "NONE", signatures, codeowners), false);
  assert.equal(hasSigned("mallory", "NONE", signatures, "# @mallory\n* @stefan-zpc\n"), false);
});
