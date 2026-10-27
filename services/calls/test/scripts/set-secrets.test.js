// scripts/set-secrets.sh: Stefan stores the Realtime and TURN credentials with wrangler's hidden prompt. The script
// never reads, echoes or stores a value itself, and only knows the four secret names /health checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const path = new URL("../../scripts/set-secrets.sh", import.meta.url).pathname;
const script = readFileSync(path, "utf8");
const code = script
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

test("puts each secret through wrangler's prompt, per environment", () => {
  assert.match(script, /npx wrangler secret put "\$name" --env "\$env"/);
  for (const name of ["REALTIME_APP_ID", "REALTIME_APP_SECRET", "TURN_KEY_ID", "TURN_KEY_API_TOKEN"]) {
    assert.match(script, new RegExp(name));
  }
});

test("never reads, echoes or stores a value", () => {
  assert.doesNotMatch(code, /\bread\b|set -x|tee |--var|> *[^&/]/);
});

test("refuses an unknown environment or secret name", () => {
  assert.equal(spawnSync("bash", [path, "dev"]).status, 2);
  assert.equal(spawnSync("bash", [path, "staging", "SOMETHING_ELSE"]).status, 2);
});
