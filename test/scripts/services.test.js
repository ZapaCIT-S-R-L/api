// The repo is becoming a monorepo: the root is the account API, each folder in services/ is its own Worker with
// its own package, CI and deploy (services/calls first). The root workflows must not deploy or lint a service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const workflow = (name) => parse(read(`.github/workflows/${name}`));

test("the API deploy ignores changes that only touch services/", () => {
  const on = workflow("deploy.yml").on;
  assert.deepEqual(on.push["paths-ignore"], ["services/**"]);
});

test("the API CI still runs on every PR (its jobs are required checks; a path filter would block services PRs)", () => {
  const on = workflow("ci.yml").on;
  assert.equal(on.pull_request?.paths, undefined);
  assert.equal(on.pull_request?.["paths-ignore"], undefined);
});

test("the API lint skips services/ (each service lints itself)", () => {
  assert.match(read(".prettierignore"), /^services\/$/m);
  assert.match(read("eslint.config.js"), /"services\/"/);
});

test("calls has its own CI, for changes to services/calls only", () => {
  const ci = workflow("ci-calls.yml");
  for (const trigger of [ci.on.pull_request, ci.on.push]) {
    assert.ok(trigger.paths.includes("services/calls/**"));
  }
  assert.equal(ci.defaults.run["working-directory"], "services/calls");
  const runs = Object.values(ci.jobs).flatMap((job) => job.steps.map((s) => String(s.run ?? "")));
  for (const command of ["npm test", "npm run lint", "npm run test:e2e", "wrangler deploy --dry-run --env staging"]) {
    assert.ok(
      runs.some((r) => r.includes(command)),
      command,
    );
  }
  assert.ok(runs.some((r) => /npm audit --omit=dev --audit-level=high/.test(r)));
});

test("calls deploys staging from main through the protected environment", () => {
  const deploy = workflow("deploy-calls.yml");
  assert.deepEqual(deploy.on.push.branches, ["main"]);
  assert.ok(deploy.on.push.paths.includes("services/calls/**"));
  assert.equal(deploy.jobs.staging.environment.name, "staging");
  assert.equal(deploy.jobs.staging.environment.url, "https://calls-staging.zapakid.ro/health");
  const runs = deploy.jobs.staging.steps.map((s) => String(s.run ?? "")).join("\n");
  assert.match(runs, /wrangler deploy --env staging/);
  assert.match(runs, /wrangler rollback --env/);
  assert.match(runs, /wrangler d1 migrations apply DB --env/);
});

// Production deploys are off until the v1 cutover (PR #110). When they come back, restore the production checks.
test("calls has no production deploy job while production deploys are off", () => {
  assert.equal(workflow("deploy-calls.yml").jobs.production, undefined);
});

// Regression: deploy-calls run 40578142642. Cloudflare refuses to roll back across a Durable Object migration, and the
// step reported "the rollback failed too: check the Worker now". That case is expected: it must say "fix forward".
test("a calls rollback blocked by a Durable Object migration says fix forward", () => {
  const deploy = workflow("deploy-calls.yml");
  const step = deploy.jobs.staging.steps.find((s) => /wrangler rollback/.test(String(s.run ?? "")));
  assert.match(step.run, /grep -q "Durable Object migration"/);
  assert.match(step.run, /a Durable Object migration[^"]*Fix forward/);
});

test("Dependabot and the daily audit cover services/calls", () => {
  const dependabot = parse(read(".github/dependabot.yml"));
  assert.ok(dependabot.updates.some((u) => u["package-ecosystem"] === "npm" && u.directory === "/services/calls"));
  assert.match(read(".github/workflows/audit.yml"), /services\/calls\/package-lock\.json/);
});

test("services/calls is a self-contained package with its own lockfile and local CI", () => {
  for (const file of ["package.json", "package-lock.json", "wrangler.jsonc", "openapi.yaml", "scripts/check.sh"]) {
    assert.ok(existsSync(new URL(`../../services/calls/${file}`, import.meta.url)), file);
  }
});
