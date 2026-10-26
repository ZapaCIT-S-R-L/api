// The app id is ro.zapakid.app (iOS bundle id and Android package; decided 2026-10-26). The old id must not
// appear anywhere in the repo. It is spelled in two parts here so this file doesn't match itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const OLD_ID = ["com", "zapacit", ["cuz", "aai"].join("")].join(".");

test("the old app id appears nowhere in tracked files", () => {
  let hits = "";
  try {
    hits = execFileSync("git", ["grep", "-n", "-i", "-F", OLD_ID.split(".").at(-1)], { encoding: "utf8" });
  } catch (e) {
    if (e.status !== 1) throw e; // 1 = no match
  }
  assert.equal(hits, "", `still names the old app id:\n${hits}`);
});
