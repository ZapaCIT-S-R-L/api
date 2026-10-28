// deploy-calls.yml waits with this until the chat Worker serves ChatMembership.revoked (api #81), so calls is never
// live before a chat Worker that can answer its revocation checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { waitForRpc } from "../../scripts/wait-for-rpc.js";

async function serve(responses) {
  let i = 0;
  const server = createServer((_req, res) => {
    const [status, body] = responses[Math.min(i++, responses.length - 1)];
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close(), calls: () => i };
}

test("waits through an old chat Worker (no rpc, then without revoked) until every method is listed", async () => {
  const s = await serve([
    [500, { error: "starting" }],
    [200, { status: "ok", version: "chat-v1.4.0" }],
    [200, { status: "ok", version: "chat-v1.4.1", rpc: ["member"] }],
    [200, { status: "ok", version: "chat-v1.5.0", rpc: ["member", "revoked"] }],
  ]);
  try {
    await waitForRpc(s.url, ["member", "revoked"], { timeoutMs: 5000, intervalMs: 10 });
    assert.equal(s.calls(), 4);
  } finally {
    s.close();
  }
});

test("a misconfigured Worker listing the methods doesn't count", async () => {
  const s = await serve([[503, { status: "misconfigured", rpc: ["member", "revoked"] }]]);
  try {
    await assert.rejects(waitForRpc(s.url, ["revoked"], { timeoutMs: 100, intervalMs: 10 }), /revoked.*503/s);
  } finally {
    s.close();
  }
});

test("gives up after the timeout with the last answer in the error", async () => {
  const s = await serve([[200, { status: "ok", version: "chat-v1.4.0", rpc: ["member"] }]]);
  try {
    await assert.rejects(
      waitForRpc(s.url, ["member", "revoked"], { timeoutMs: 100, intervalMs: 10 }),
      /never listed rpc member, revoked.*chat-v1\.4\.0/s,
    );
  } finally {
    s.close();
  }
});
