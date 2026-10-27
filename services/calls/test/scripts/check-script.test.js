// scripts/check.sh (run before every push) must keep running what the calls CI runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const script = readFileSync(new URL("../../scripts/check.sh", import.meta.url), "utf8");
const ci = readFileSync(new URL("../../../../.github/workflows/ci-calls.yml", import.meta.url), "utf8");

for (const command of [
  "npm run lint",
  "npm test",
  "wrangler deploy --dry-run --env staging",
  "npm run test:e2e",
  "wrangler d1 migrations apply DB --local",
  "npm audit --omit=dev --audit-level=high",
  "scan source --lockfile package-lock.json",
]) {
  test(`check.sh and ci-calls.yml both run: ${command}`, () => {
    assert.ok(script.includes(command), "check.sh");
    assert.ok(ci.includes(command), "ci-calls.yml");
  });
}
