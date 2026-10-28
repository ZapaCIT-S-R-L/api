// Regression test (security review 2026-10-27, L3): every container a workflow runs is pinned by digest, not by a
// tag someone could move, and gets the checkout read-only, so it can't change the code it reports on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../../.github/workflows/", import.meta.url);

for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
  // A command may be folded over several lines (`run: >-`): join each `docker run` with its continuation lines.
  const lines = readFileSync(new URL(file, dir), "utf8").split("\n");
  const runs = [];
  lines.forEach((line, i) => {
    if (!/\bdocker run\b/.test(line)) return;
    const indent = line.search(/\S/);
    let command = line;
    for (
      let j = i + 1;
      j < lines.length && (lines[j] ?? "").search(/\S/) >= indent && !/^\s*-\s/.test(lines[j] ?? "");
      j++
    ) {
      command += ` ${(lines[j] ?? "").trim()}`;
    }
    runs.push(command);
  });
  for (const line of runs) {
    test(`${file}: ${line.trim().slice(0, 60)}…`, () => {
      assert.match(line, /\s[\w./-]+(:[\w.-]+)?@sha256:[0-9a-f]{64}\b/, "image pinned by digest");
      for (const mount of line.matchAll(/-v\s+(\S+)/g))
        assert.match(mount[1] ?? "", /:ro"?$/, `mount ${mount[1]} read-only`);
    });
  }
}
