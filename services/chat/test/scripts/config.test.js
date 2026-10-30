// Tests for wrangler.jsonc: each deployed environment has its own host, keys, data (EU) and counters, trusts only
// its own account service, and never gets the local test hooks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { experimental_readRawConfig } from "wrangler";

const { rawConfig } = experimental_readRawConfig({ config: "wrangler.jsonc" });
const { staging, production } = rawConfig.env;
const deployed = { staging, production };

test("hosts: chat-staging.zapakid.ro and chat.zapakid.ro, no workers.dev or preview URLs", () => {
  assert.deepEqual(staging.routes, [{ pattern: "chat-staging.zapakid.ro", custom_domain: true }]);
  assert.deepEqual(production.routes, [{ pattern: "chat.zapakid.ro", custom_domain: true }]);
  for (const env of [rawConfig, staging, production]) {
    assert.equal(env.workers_dev, false);
    assert.equal(env.preview_urls, false);
  }
  assert.equal(rawConfig.routes, undefined);
});

test("chat tokens: each environment trusts only its own account service, over https", () => {
  assert.deepEqual(
    [staging.vars.TOKEN_ISSUER, staging.vars.TOKEN_AUDIENCE, staging.vars.ACCOUNT_JWKS_URL],
    [
      "https://api-staging.zapakid.ro",
      "chat-staging.zapakid.ro",
      "https://api-staging.zapakid.ro/.well-known/jwks.json",
    ],
  );
  assert.deepEqual(
    [production.vars.TOKEN_ISSUER, production.vars.TOKEN_AUDIENCE, production.vars.ACCOUNT_JWKS_URL],
    ["https://api.zapakid.ro", "chat.zapakid.ro", "https://api.zapakid.ro/.well-known/jwks.json"],
  );
});

test("deployed conversation objects live in the EU jurisdiction", () => {
  for (const env of [staging, production]) {
    assert.equal(env.vars.ROOMS_JURISDICTION, "eu");
    assert.deepEqual(env.durable_objects.bindings, [
      { name: "ROOMS", class_name: "ConversationRoom" },
      { name: "ACCOUNTS", class_name: "AccountHub" },
    ]);
  }
  assert.equal(rawConfig.vars.ROOMS_JURISDICTION, undefined, "workerd has no jurisdictions");
});

test("the local test hooks never reach a deployed environment", () => {
  for (const [name, env] of Object.entries(deployed)) {
    assert.equal(env.vars.E2E_HOOKS, undefined, name);
    assert.deepEqual(
      env.queues?.producers,
      [{ binding: "CONVERSATION_EVENTS", queue: `zapakid-conversation-events-${name}` }],
      `${name}: the only producer is the conversation events queue for the calls service (no MEMBERSHIP_E2E)`,
    );
  }
});

test("each environment has its own D1 database and membership queue with a dead-letter queue", () => {
  for (const [name, env] of Object.entries(deployed)) {
    assert.deepEqual(
      env.d1_databases.map((d) => [d.binding, d.database_name]),
      [["DB", `zapakid-chat-${name}`]],
    );
    const [consumer, ...more] = env.queues.consumers;
    assert.equal(more.length, 0);
    assert.equal(consumer.queue, `zapakid-membership-${name}`);
    assert.equal(consumer.dead_letter_queue, `zapakid-membership-${name}-dlq`);
    assert.equal(consumer.max_concurrency, 1, "events apply in order");
    assert.ok(consumer.max_retries >= 3);
  }
});

test("rate limits: separate counters per environment, never shared with the account service (1001-3001)", () => {
  const ids = [rawConfig, staging, production].flatMap((env) => env.ratelimits.map((r) => r.namespace_id));
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^4[123]\d\d$/);
  for (const env of [staging, production]) {
    for (const r of env.ratelimits) assert.ok(r.simple.limit <= 200, `${r.name} ${r.simple.limit}`);
  }
});

test("each environment has its own attachments bucket in the EU jurisdiction", () => {
  for (const [name, env] of Object.entries(deployed)) {
    assert.deepEqual(env.r2_buckets, [
      { binding: "ATTACHMENTS", bucket_name: `zapakid-chat-attachments-${name}`, jurisdiction: "eu" },
    ]);
  }
});

test("hourly retention purge in every deployed environment", () => {
  for (const env of [staging, production]) assert.deepEqual(env.triggers, { crons: ["23 * * * *"] });
});

// Every binding and variable the Worker requires (non-optional fields of Env in src/env.ts) is defined for each
// deployed environment, since bindings and vars are not inherited from the top level.
test("staging and production define every binding and var the Worker reads", () => {
  const source = readFileSync(new URL("../../src/env.ts", import.meta.url), "utf8");
  const envBlock = source.slice(source.indexOf("export interface Env {"), source.indexOf("\n}\n"));
  const required = [...envBlock.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
  assert.ok(required.includes("DB") && required.includes("TOKEN_ISSUER"), "parsed src/env.ts");
  for (const [name, env] of Object.entries(deployed)) {
    const defined = new Set([
      ...Object.keys(env.vars ?? {}),
      ...(env.d1_databases ?? []).map((d) => d.binding),
      ...(env.ratelimits ?? []).map((r) => r.name),
      ...(env.r2_buckets ?? []).map((r) => r.binding),
      ...(env.durable_objects?.bindings ?? []).map((d) => d.name),
    ]);
    for (const key of required) assert.ok(defined.has(key), `${name} is missing ${key}`);
  }
});

// The calls service's CHAT service binding names these Workers (services/calls/wrangler.jsonc); renaming one breaks
// every call.
test("Worker names: zapakid-chat locally, zapakid-chat-staging and zapakid-chat-production when deployed", () => {
  assert.equal(rawConfig.name, "zapakid-chat");
  assert.equal(staging.name, undefined);
  assert.equal(production.name, undefined);
});
