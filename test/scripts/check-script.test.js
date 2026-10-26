// scripts/check.sh (run before every push) must keep running what CI runs. If a CI job gains a check, add it there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const script = readFileSync(new URL("../../scripts/check.sh", import.meta.url), "utf8");
const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

const checks = [
  ["lint", "npm run lint"],
  ["lint", "actionlint"],
  ["unit", "npm test"],
  ["build", "wrangler deploy --dry-run --env staging"],
  ["e2e", "npm run test:e2e"],
  ["e2e", "wrangler d1 migrations apply DB --local"],
  ["audit", "npm audit --omit=dev --audit-level=high"],
  ["secrets", "gitleaks"],
];

for (const [job, command] of checks) {
  test(`check.sh runs the ${job} check: ${command}`, () => {
    assert.ok(ci.includes(`  ${job}:`), `ci.yml has a ${job} job`);
    assert.ok(script.includes(command), `check.sh runs ${command}`);
  });
}

test("check.sh also builds the release SBOM and runs OSV-Scanner", () => {
  assert.ok(script.includes("npm sbom --sbom-format cyclonedx --omit dev --package-lock-only"));
  assert.ok(script.includes("osv-scanner scan source --lockfile package-lock.json"));
});
