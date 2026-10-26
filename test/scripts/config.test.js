// Tests for wrangler.jsonc: deployed environments use only the real Apple and Google keys and ZapaKid's app ids,
// keep data in the EU, and never get the local test overrides.
import { test } from "node:test";
import assert from "node:assert/strict";
import { experimental_readRawConfig } from "wrangler";

const { rawConfig } = experimental_readRawConfig({ config: "wrangler.jsonc" });
const staging = rawConfig.env.staging;

test("staging serves api-staging.zapakid.ro only, no workers.dev or preview URLs", () => {
  assert.deepEqual(staging.routes, [{ pattern: "api-staging.zapakid.ro", custom_domain: true }]);
  assert.equal(staging.workers_dev, false);
  assert.equal(staging.preview_urls, false);
});

test("no environment touches api.zapakid.ro yet (it still serves v0.1)", () => {
  for (const [name, env] of Object.entries(rawConfig.env)) {
    for (const route of env.routes ?? []) assert.notEqual(route.pattern, "api.zapakid.ro", name);
  }
  assert.equal(rawConfig.routes, undefined);
});

test("staging never overrides the Apple or Google key URLs", () => {
  assert.equal(staging.vars.APPLE_JWKS_URL, undefined);
  assert.equal(staging.vars.GOOGLE_JWKS_URL, undefined);
});

// The app id (iOS bundle id) first; then, once Stefan provides it, the Apple Services ID of the web flow (Android).
function appleAudiences(env) {
  const ids = env.vars.APPLE_AUDIENCES.split(",").map((id) => id.trim());
  assert.equal(ids[0], "ro.zapakid.app");
  for (const id of ids) assert.match(id, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i);
  assert.ok(!ids.some((id) => id.endsWith(".local")), "no local test ids");
  return ids;
}

test("staging accepts Apple tokens for the ZapaKid app and its Services ID (web flow) only", () => {
  assert.deepEqual(appleAudiences(staging), ["ro.zapakid.app", "ro.zapakid.signin"]);
});

test("the Apple web flow hands back to the app link on zapakid.ro", () => {
  for (const env of [staging, production])
    assert.equal(env.vars.APPLE_WEB_REDIRECT_URL, "https://zapakid.ro/app/apple");
});

// Google ID tokens carry the client the app asked with as `aud`: Android (Credential Manager, setServerClientId)
// uses the web (server) client, iOS (GoogleSignIn) the iOS client. The Android client id is never an audience.
const GOOGLE_WEB = "64042746735-r70nv5pmlro7hpksk1te3ur008ungss1.apps.googleusercontent.com";
const GOOGLE_IOS = "64042746735-lgdmtj9vvd3kiu7g9qc2elu22la6o1id.apps.googleusercontent.com";
const GOOGLE_ANDROID = "64042746735-mbidtcoq0nsrka4b60vjmspdit6h095b.apps.googleusercontent.com";

test("staging accepts Google ID tokens for ZapaKid's web and iOS clients only", () => {
  const ids = staging.vars.GOOGLE_CLIENT_IDS.split(",");
  assert.deepEqual(ids, [GOOGLE_WEB, GOOGLE_IOS]);
  assert.ok(!ids.includes(GOOGLE_ANDROID));
});

test("staging session TTL is between 1 day and 90 days", () => {
  const ttl = Number(staging.vars.SESSION_TTL_SECONDS);
  assert.ok(Number.isInteger(ttl) && ttl >= 86_400 && ttl <= 7_776_000, String(ttl));
});

test("staging has its own D1 database", () => {
  assert.equal(staging.d1_databases.length, 1);
  assert.equal(staging.d1_databases[0].binding, "DB");
  assert.equal(staging.d1_databases[0].database_name, "zapakid-api-staging");
});

const production = rawConfig.env.production;

test("production has no route and no public URL until the v1 cutover", () => {
  assert.equal(production.routes, undefined);
  assert.equal(production.route, undefined);
  assert.equal(production.workers_dev, false);
  assert.equal(production.preview_urls, false);
});

test("production trusts only the real keys and the ZapaKid app", () => {
  assert.equal(production.vars.APPLE_JWKS_URL, undefined);
  assert.equal(production.vars.GOOGLE_JWKS_URL, undefined);
  assert.deepEqual(appleAudiences(production), ["ro.zapakid.app"]);
  assert.ok(!production.vars.GOOGLE_CLIENT_IDS.includes("local-test"));
  assert.equal(production.d1_databases[0].database_name, "zapakid-api-production");
});

test("auth rate limits: staging and production 20 per minute, separate counters per environment", () => {
  const limiter = (env) => (env.ratelimits ?? []).find((r) => r.name === "AUTH_LIMITER");
  for (const env of [staging, production]) assert.deepEqual(limiter(env).simple, { limit: 20, period: 60 });
  const ids = [limiter(rawConfig), limiter(staging), limiter(production)].map((r) => r.namespace_id);
  assert.equal(new Set(ids).size, 3);
});

test("staging and production purge expired sessions and nonces daily", () => {
  for (const env of [staging, production]) assert.deepEqual(env.triggers, { crons: ["17 3 * * *"] });
});

// Regression guard: every binding and variable the Worker requires (non-optional fields of Env in src/env.ts)
// is defined for each deployed environment, since bindings and vars are not inherited from the top level.
test("staging and production define every binding and var the Worker reads", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../../src/env.ts", import.meta.url), "utf8");
  const envBlock = source.slice(source.indexOf("export interface Env {"), source.indexOf("\n}\n"));
  const required = [...envBlock.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
  assert.ok(required.includes("DB") && required.includes("VERSION"), "parsed src/env.ts");
  for (const [name, env] of Object.entries({ staging, production })) {
    const defined = new Set([
      ...Object.keys(env.vars ?? {}),
      ...(env.d1_databases ?? []).map((d) => d.binding),
      ...(env.ratelimits ?? []).map((r) => r.name),
    ]);
    for (const key of required) assert.ok(defined.has(key), `${name} is missing ${key}`);
  }
});

test("app attestation: production required, staging optional until Play Integrity is set up", () => {
  assert.equal(production.vars.ATTESTATION_POLICY, "required");
  assert.equal(staging.vars.ATTESTATION_POLICY, "optional");
  for (const env of [staging, production]) {
    assert.equal(env.vars.PLAY_PACKAGE_NAME, "ro.zapakid.app");
    assert.equal(env.vars.PLAY_INTEGRITY_CREDENTIALS, undefined, "a secret, never a var");
  }
});
