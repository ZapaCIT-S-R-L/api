// Tests for services/calls/wrangler.jsonc: the deployed environments trust only the real account API, call the
// real Cloudflare Realtime, keep data in the EU and never get local test overrides or secrets as plain vars.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { experimental_readRawConfig } from "wrangler";

const { rawConfig } = experimental_readRawConfig({ config: "wrangler.jsonc" });
const { staging, production } = rawConfig.env;
const deployed = { staging, production };

test("staging serves calls-staging.zapakid.ro, production calls.zapakid.ro; no workers.dev or preview URLs", () => {
  assert.deepEqual(staging.routes, [{ pattern: "calls-staging.zapakid.ro", custom_domain: true }]);
  assert.deepEqual(production.routes, [{ pattern: "calls.zapakid.ro", custom_domain: true }]);
  for (const env of [rawConfig, staging, production]) {
    assert.equal(env.workers_dev, false);
    assert.equal(env.preview_urls, false);
  }
});

test("chat tokens: the account API of the same environment is the only issuer, this host the audience", () => {
  assert.equal(staging.vars.ACCOUNT_JWKS_URL, "https://api-staging.zapakid.ro/.well-known/jwks.json");
  assert.equal(staging.vars.TOKEN_ISSUER, "https://api-staging.zapakid.ro");
  assert.equal(staging.vars.TOKEN_AUDIENCE, "calls-staging.zapakid.ro");
  assert.equal(production.vars.ACCOUNT_JWKS_URL, "https://api.zapakid.ro/.well-known/jwks.json");
  assert.equal(production.vars.TOKEN_ISSUER, "https://api.zapakid.ro");
  assert.equal(production.vars.TOKEN_AUDIENCE, "calls.zapakid.ro");
});

test("each deployed environment has its own EU D1 database for the call log", () => {
  for (const [name, env] of Object.entries(deployed)) {
    assert.equal(env.d1_databases.length, 1);
    assert.equal(env.d1_databases[0].binding, "DB");
    assert.equal(env.d1_databases[0].database_name, `zapakid-calls-${name}`);
  }
});

test("no secret is ever a plain var", () => {
  for (const env of [rawConfig, staging, production]) {
    for (const name of Object.keys(env.vars ?? {})) assert.doesNotMatch(name, /SECRET|TOKEN$|API_TOKEN|_KEY$/, name);
  }
});

// Regression guard: every binding and variable the Worker requires (non-optional fields of Env in src/env.ts)
// is defined for each deployed environment, since bindings and vars are not inherited from the top level.
test("staging and production define every binding and var the Worker reads", () => {
  const source = readFileSync(new URL("../../src/env.ts", import.meta.url), "utf8");
  const envBlock = source.slice(source.indexOf("export interface Env {"), source.indexOf("\n}\n"));
  const required = [...envBlock.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
  assert.ok(required.includes("DB") && required.includes("VERSION"), "parsed src/env.ts");
  for (const [name, env] of Object.entries(deployed)) {
    const defined = new Set([
      ...Object.keys(env.vars ?? {}),
      ...(env.d1_databases ?? []).map((d) => d.binding),
      ...(env.ratelimits ?? []).map((r) => r.name),
      ...(env.durable_objects?.bindings ?? []).map((b) => b.name),
    ]);
    for (const key of required) assert.ok(defined.has(key), `${name} is missing ${key}`);
  }
});
