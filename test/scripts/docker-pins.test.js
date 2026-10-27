// Regression test (security review 2026-10-27, L3): every container a workflow runs is pinned by digest, not by a
// tag someone could move, and gets the checkout read-only, so it can't change the code it reports on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../../.github/workflows/", import.meta.url);

for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
  const runs = readFileSync(new URL(file, dir), "utf8")
    .split("\n")
    .filter((line) => /\bdocker run\b/.test(line));
  for (const line of runs) {
    test(`${file}: ${line.trim().slice(0, 60)}…`, () => {
      assert.match(line, /\s[\w./-]+(:[\w.-]+)?@sha256:[0-9a-f]{64}\b/, "image pinned by digest");
      for (const mount of line.matchAll(/-v\s+(\S+)/g))
        assert.match(mount[1] ?? "", /:ro"?$/, `mount ${mount[1]} read-only`);
    });
  }
}
