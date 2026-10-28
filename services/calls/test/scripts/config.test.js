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

test("each deployed environment consumes its own conversation events queue, with a dead-letter queue", () => {
  for (const [name, env] of Object.entries(deployed)) {
    assert.equal(env.queues?.producers, undefined, `${name}: the chat service produces, calls only consumes`);
    const [consumer, ...more] = env.queues.consumers;
    assert.equal(more.length, 0);
    assert.equal(consumer.queue, `zapakid-conversation-events-${name}`);
    assert.equal(consumer.dead_letter_queue, `zapakid-conversation-events-${name}-dlq`);
    assert.ok(consumer.max_batch_timeout <= 2, "a removed member is out of the call within seconds");
    assert.ok(consumer.max_retries >= 3);
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
      ...(env.services ?? []).map((s) => s.binding),
    ]);
    for (const key of required) assert.ok(defined.has(key), `${name} is missing ${key}`);
  }
});

test("Realtime and TURN: the real Cloudflare API in every deployed environment; the credentials are secrets", () => {
  for (const env of [staging, production]) {
    assert.equal(env.vars.REALTIME_API_URL, "https://rtc.live.cloudflare.com/v1");
    for (const secret of ["REALTIME_APP_ID", "REALTIME_APP_SECRET", "TURN_KEY_ID", "TURN_KEY_API_TOKEN"]) {
      assert.equal(env.vars[secret], undefined, `${secret} is a secret`);
    }
  }
});

test("call limits: at most 8 participants, 30 s ring (about 5 rings), 2 h, TURN credentials at most 1 h", () => {
  for (const env of [rawConfig, staging, production]) {
    assert.equal(env.vars.MAX_PARTICIPANTS, "8");
    assert.equal(env.vars.RING_TIMEOUT_SECONDS, "30");
    assert.equal(env.vars.MAX_CALL_SECONDS, "7200");
    assert.ok(Number(env.vars.TURN_TTL_SECONDS) <= 3600);
    assert.equal(env.vars.RECONNECT_GRACE_SECONDS, "30");
  }
});

test("one Durable Object per call (SQLite-backed), bound in every environment", () => {
  assert.deepEqual(rawConfig.migrations, [{ tag: "v1", new_sqlite_classes: ["CallRoom"] }]);
  for (const env of [rawConfig, staging, production]) {
    assert.deepEqual(env.durable_objects.bindings, [{ name: "CALL", class_name: "CallRoom" }]);
  }
});

test("rate limits per account: separate counters per environment", () => {
  const ids = [];
  for (const env of [rawConfig, staging, production]) {
    const names = env.ratelimits.map((r) => r.name).sort();
    assert.deepEqual(names, ["CREATE_LIMITER", "JOIN_LIMITER"]);
    ids.push(...env.ratelimits.map((r) => r.namespace_id));
  }
  assert.equal(new Set(ids).size, ids.length);
  for (const env of [staging, production]) {
    assert.deepEqual(env.ratelimits.find((r) => r.name === "CREATE_LIMITER").simple, { limit: 10, period: 60 });
    assert.deepEqual(env.ratelimits.find((r) => r.name === "JOIN_LIMITER").simple, { limit: 30, period: 60 });
  }
});

test("the call log is purged daily; kept at most a year", () => {
  for (const env of [staging, production]) {
    assert.deepEqual(env.triggers, { crons: ["23 3 * * *"] });
    const days = Number(env.vars.CALL_LOG_RETENTION_DAYS);
    assert.ok(Number.isInteger(days) && days >= 1 && days <= 365, String(days));
  }
});

// Membership comes from the chat service of the same environment, over Workers RPC (a service binding, never public
// HTTP): its ChatMembership entrypoint (services/chat/src/rpc.ts).
test("CHAT: a service binding to the chat Worker of the same environment, its ChatMembership entrypoint", () => {
  const chat = (env) => (env.services ?? []).filter((s) => s.binding === "CHAT");
  assert.deepEqual(chat(rawConfig), [{ binding: "CHAT", service: "zapakid-chat", entrypoint: "ChatMembership" }]);
  assert.deepEqual(chat(staging), [{ binding: "CHAT", service: "zapakid-chat-staging", entrypoint: "ChatMembership" }]);
  assert.deepEqual(chat(production), [
    { binding: "CHAT", service: "zapakid-chat-production", entrypoint: "ChatMembership" },
  ]);
});

// The local e2e run (scripts/check.sh, ci-calls.yml) runs the chat stub under the chat Worker's local name.
test("the e2e chat stub stands in for zapakid-chat and is never deployed", () => {
  const { rawConfig: stub } = experimental_readRawConfig({ config: "test/chat-stub/wrangler.jsonc" });
  assert.equal(stub.name, "zapakid-chat");
  assert.equal(stub.env, undefined);
  assert.equal(stub.routes, undefined);
  assert.equal(stub.workers_dev, false);
});
