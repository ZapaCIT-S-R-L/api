// Regression test (security review 2026-10-27, M2): the Cloudflare API token reaches only the steps that run
// wrangler, never `npm ci` (install scripts of any dependency) or the test suites. Every install skips scripts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";

const dir = new URL("../../.github/workflows/", import.meta.url);
const workflows = readdirSync(dir)
  .filter((f) => f.endsWith(".yml"))
  .map((f) => ({ file: f, doc: parse(readFileSync(new URL(f, dir), "utf8")) }));

const SECRET = "CLOUDFLARE_API_TOKEN";
// The secret's value itself, `${{ secrets.CLOUDFLARE_API_TOKEN }}` (a comparison like `!= ''` gives only true/false).
const usesSecret = (env) =>
  Object.values(env ?? {}).some((v) => new RegExp(`\\$\\{\\{\\s*secrets\\.${SECRET}\\s*\\}\\}`).test(String(v)));

for (const { file, doc } of workflows) {
  test(`${file}: the Cloudflare token is not set for the whole workflow or job`, () => {
    assert.ok(!usesSecret(doc.env), "workflow-level env");
    for (const [name, job] of Object.entries(doc.jobs ?? {})) assert.ok(!usesSecret(job.env), `job ${name} env`);
  });

  test(`${file}: only steps that run wrangler get the Cloudflare token`, () => {
    for (const job of Object.values(doc.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (!usesSecret(step.env)) continue;
        const run = String(step.run ?? "");
        assert.ok(
          /wrangler|d1-database\.js|bootstrap-secrets\.js/.test(run),
          `step "${step.name ?? run.slice(0, 40)}" gets the token`,
        );
        assert.ok(
          !/npm (ci|install|test)|npm run test/.test(run),
          `step "${step.name}" installs or tests with the token`,
        );
      }
    }
  });

  test(`${file}: npm ci never runs install scripts`, () => {
    for (const job of Object.values(doc.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        for (const line of String(step.run ?? "").split("\n")) {
          if (/\bnpm ci\b/.test(line)) assert.match(line, /--ignore-scripts/, line);
        }
      }
    }
  });
}
