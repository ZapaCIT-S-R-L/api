// Regression test: the first staging deploy (run 40392491886) failed its e2e with 500s from /health while the new
// custom domain came up, then served fine a minute later. deploy.yml now waits for the new version first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { waitForVersion } from "../../scripts/wait-for-version.js";

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

test("waits through 500s and the old version until /health reports the new one", async () => {
  const s = await serve([
    [500, { error: "starting" }],
    [200, { status: "ok", version: "v1.0.1" }],
    [200, { status: "ok", version: "v1.0.2" }],
  ]);
  try {
    await waitForVersion(s.url, "v1.0.2", { timeoutMs: 5000, intervalMs: 10 });
    assert.equal(s.calls(), 3);
  } finally {
    s.close();
  }
});

test("gives up after the timeout with the last answer in the error", async () => {
  const s = await serve([[500, { error: "down" }]]);
  try {
    await assert.rejects(waitForVersion(s.url, "v9.9.9", { timeoutMs: 100, intervalMs: 10 }), /v9\.9\.9.*500/s);
  } finally {
    s.close();
  }
});

test("a network error counts as not ready yet", async () => {
  await assert.rejects(waitForVersion("http://127.0.0.1:9", "v1.0.0", { timeoutMs: 100, intervalMs: 10 }));
});
