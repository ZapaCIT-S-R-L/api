// api #81: calls asks the chat Worker's ChatMembership.revoked on every request, so calls must never go live before a
// chat Worker that serves it. deploy-calls.yml enforces that by waiting, in each stage, before anything is changed,
// until the chat Worker of the same environment lists every method calls uses on /health.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync("../../.github/workflows/deploy-calls.yml", "utf8");
const chatClient = readFileSync("src/chat.ts", "utf8");

// The method names of the ChatMembershipRpc interface in src/chat.ts.
function rpcMethods() {
  const body = /export interface ChatMembershipRpc \{([\s\S]*?)\n\}/.exec(chatClient)?.[1] ?? "";
  return [...body.matchAll(/^\s+(\w+)\(/gm)].map((m) => m[1]).sort();
}

function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `job ${name}`);
  const next = workflow.slice(start + 1).search(/\n {2}\w[\w-]*:\n/);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

test("CHAT_RPC lists every ChatMembership method calls uses", () => {
  const listed = /\n {2}CHAT_RPC: (.+)\n/.exec(workflow)?.[1].trim().split(/\s+/).sort();
  assert.deepEqual(listed, rpcMethods());
  assert.ok(listed.includes("revoked"));
});

for (const [name, chatUrl] of [
  ["staging", "https://chat-staging.zapakid.ro"],
  ["production", "https://chat.zapakid.ro"],
]) {
  test(`${name}: waits for the ${name} chat Worker's RPC before migrations and the deploy`, () => {
    const steps = job(name);
    const wait = steps.indexOf(`node ../../scripts/wait-for-rpc.js ${chatUrl} $CHAT_RPC`);
    assert.notEqual(wait, -1);
    assert.ok(wait < steps.indexOf("wrangler d1 migrations apply"));
    assert.ok(wait < steps.indexOf(`npx wrangler deploy --env ${name}`));
  });
}
