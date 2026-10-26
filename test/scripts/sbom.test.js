// Regression test: the release SBOM (deploy.yml) must build. On 2026-10-26 the first staging deploy failed in
// `npm sbom` because package.json had no version (EINVALIDPURLTYPE). This runs the same command.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("npm sbom (CycloneDX, runtime dependencies) builds and names the API and jose", () => {
  const out = execFileSync("npm", ["sbom", "--sbom-format", "cyclonedx", "--omit", "dev", "--package-lock-only"], {
    encoding: "utf8",
  });
  const sbom = JSON.parse(out);
  assert.equal(sbom.bomFormat, "CycloneDX");
  // npm takes metadata.component.name from the folder; the purl has the package name and version.
  assert.match(sbom.metadata.component.purl, /^pkg:npm\/zapakid-api@\d+\.\d+\.\d+$/);
  assert.ok(sbom.components.some((c) => c.name === "jose"));
  assert.ok(!sbom.components.some((c) => c.name === "wrangler"), "dev dependencies are left out");
});
