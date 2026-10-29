// Services under services/ have their own CI and deploy workflows. A PR that changes only services/** must not
// redeploy the account API, and must still get the checks the main ruleset requires (unit, build, e2e, lint):
// those are skipped by a job condition, never dropped with paths-ignore (a missing required check blocks merging).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";

const dir = new URL("../../.github/workflows/", import.meta.url);
const load = (file) => parse(readFileSync(new URL(file, dir), "utf8"));

test("ci.yml runs on every PR, and skips the account API checks only for services-only changes", () => {
  const ci = load("ci.yml");
  assert.equal(ci.on.pull_request, null, "no path filter on pull_request");
  assert.ok(ci.jobs.changes, "a changes job");
  for (const job of ["unit", "build", "e2e", "lint"]) {
    assert.equal(ci.jobs[job].needs, "changes", job);
    assert.equal(ci.jobs[job].if, "needs.changes.outputs.root == 'true'", job);
  }
  for (const job of ["secrets", "audit", "cla"]) assert.equal(ci.jobs[job].needs, undefined, `${job} always runs`);
});

test("deploy.yml (account API) ignores services/**", () => {
  assert.deepEqual(load("deploy.yml").on.push["paths-ignore"], ["services/**"]);
});

test("each service's CI and staging deploy run only for that service", () => {
  const services = readdirSync(new URL("../../services/", import.meta.url));
  assert.ok(services.includes("chat"));
  for (const service of services) {
    const ci = load(`ci-${service}.yml`);
    const deploy = load(`deploy-${service}.yml`);
    for (const paths of [ci.on.pull_request.paths, ci.on.push.paths, deploy.on.push.paths]) {
      assert.ok(paths.includes(`services/${service}/**`), service);
      assert.ok(!paths.some((p) => p === "**" || p.startsWith("src/")), service);
    }
    assert.equal(ci.defaults.run["working-directory"], `services/${service}`);
    assert.equal(deploy.defaults.run["working-directory"], `services/${service}`);
  }
});

test("each service deploys staging first, then production only through the protected environment", () => {
  for (const service of readdirSync(new URL("../../services/", import.meta.url))) {
    const { jobs } = load(`deploy-${service}.yml`);
    assert.equal(jobs.staging.environment.name, "staging", service);
    // Production deploys are off until the v1 cutover (PR #110); the protected-environment check returns with the job.
    if (jobs.production) {
      assert.equal(jobs.production.environment.name, "production", service);
      assert.equal(jobs.production.needs, "staging", service);
    }
  }
});
