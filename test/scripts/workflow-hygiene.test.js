// Every workflow: third-party actions pinned by commit SHA (a tag can be moved), no shell tracing, and no step that
// prints a secret: secrets reach a step only through `env`, never pasted into the script, and no script echoes them.
// The bootstrap-secrets workflow gets extra checks: manual, per protected environment, nothing uploaded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";

const dir = new URL("../../.github/workflows/", import.meta.url);
const workflows = readdirSync(dir)
  .filter((f) => f.endsWith(".yml"))
  .map((f) => ({ file: f, doc: parse(readFileSync(new URL(f, dir), "utf8")) }));
const steps = (doc) => Object.values(doc.jobs ?? {}).flatMap((job) => job.steps ?? []);

for (const { file, doc } of workflows) {
  test(`${file}: every action is pinned by a full commit SHA`, () => {
    for (const step of steps(doc)) {
      if (!step.uses || step.uses.startsWith("./") || step.uses.startsWith("docker://")) continue;
      assert.match(step.uses, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, step.uses);
    }
  });

  test(`${file}: no step pastes a secret into its script, traces the shell or echoes a secret`, () => {
    for (const step of steps(doc)) {
      const run = String(step.run ?? "");
      assert.doesNotMatch(run, /\$\{\{\s*secrets\./, `step "${step.name ?? run.slice(0, 40)}" inlines a secret`);
      assert.doesNotMatch(run, /set -[a-z]*x|bash -x/, `step "${step.name}" traces the shell`);
      const secretVars = Object.entries(step.env ?? {})
        .filter(([, v]) => /\$\{\{\s*secrets\.[A-Z_]+\s*\}\}/.test(String(v)))
        .map(([k]) => k);
      for (const name of secretVars) {
        assert.doesNotMatch(
          run,
          new RegExp(`(echo|printf|cat <<)[^\\n]*\\$\\{?${name}\\b`),
          `step "${step.name}" prints ${name}`,
        );
      }
    }
  });
}

const bootstrap = parse(readFileSync(new URL("bootstrap-secrets.yml", dir), "utf8"));

test("bootstrap-secrets: manual only, env staging|production, rotate none by default", () => {
  assert.deepEqual(Object.keys(bootstrap.on), ["workflow_dispatch"]);
  const { env, rotate } = bootstrap.on.workflow_dispatch.inputs;
  assert.deepEqual(env.options, ["staging", "production"]);
  assert.equal(env.required, true);
  assert.deepEqual(rotate.options, ["none", "chat-token-key", "realtime", "all"]);
  assert.equal(rotate.default, "none");
});

test("bootstrap-secrets: runs in the chosen protected environment, read-only token, one run per environment", () => {
  const jobs = Object.values(bootstrap.jobs);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].environment, "${{ inputs.env }}");
  assert.deepEqual(bootstrap.permissions, { contents: "read" });
  assert.match(bootstrap.concurrency.group, /inputs\.env/);
});

test("bootstrap-secrets: the Cloudflare token reaches only the bootstrap step; nothing is uploaded", () => {
  for (const step of steps(bootstrap)) {
    assert.doesNotMatch(String(step.uses ?? ""), /upload-artifact|cache/, "no artifacts or caches");
    const hasToken = /secrets\.CLOUDFLARE_API_TOKEN/.test(JSON.stringify(step.env ?? {}));
    assert.equal(hasToken, /node scripts\/bootstrap-secrets\.js/.test(String(step.run ?? "")), step.name ?? step.run);
  }
});
