// scripts/bootstrap-secrets.js (bootstrap-secrets workflow): creates each Worker's generated secrets once, masks every
// value before anything else sees it, sends it to wrangler on stdin only, and skips what is already set or not
// deployed. The side effects (wrangler, the Cloudflare API, masking) are fakes here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { importJWK, calculateJwkThumbprint } from "jose";
import {
  bootstrap,
  decide,
  newChatTokenKey,
  putSecretWith,
  REALTIME_SECRETS,
  secretNames,
  workerName,
} from "../../scripts/bootstrap-secrets.js";

const ACCOUNT_CONFIG = new URL("../../wrangler.jsonc", import.meta.url).pathname;
const MISSING_CONFIG = new URL("../../services/none/wrangler.jsonc", import.meta.url).pathname;

test("Worker names come from the wrangler config (<name>-<env>); no config → null", () => {
  assert.equal(workerName(ACCOUNT_CONFIG, "staging"), "zapakid-api-staging");
  assert.equal(workerName(ACCOUNT_CONFIG, "production"), "zapakid-api-production");
  assert.equal(workerName(MISSING_CONFIG, "staging"), null);
});

test("reads wrangler secret list JSON", () => {
  assert.deepEqual(secretNames('[{"name":"A","type":"secret_text"},{"name":"B","type":"secret_text"}]'), ["A", "B"]);
  assert.throws(() => secretNames("{}"));
});

test("idempotent: create when any is missing, skip when all are set, rotate only when asked", () => {
  assert.equal(decide([], ["A"], "g", "none"), "create");
  assert.equal(decide(["A"], ["A", "B"], "g", "none"), "create");
  assert.equal(decide(["A", "B"], ["A", "B"], "g", "none"), "skip");
  assert.equal(decide(["A", "B"], ["A", "B"], "other", "other"), "rotate");
  assert.equal(decide(["A", "B"], ["A", "B"], "g", "all"), "rotate");
  assert.equal(decide(["A", "B"], ["A", "B"], "g", "other"), "skip");
});

test("the chat token key is a private P-256 JWK with its thumbprint as kid, new every time", async () => {
  const a = JSON.parse(await newChatTokenKey());
  const b = JSON.parse(await newChatTokenKey());
  assert.equal(a.kty, "EC");
  assert.equal(a.crv, "P-256");
  assert.equal(a.alg, "ES256");
  assert.ok(a.d);
  assert.equal(a.kid, await calculateJwkThumbprint({ kty: a.kty, crv: a.crv, x: a.x, y: a.y }));
  await importJWK(a, "ES256");
  assert.notEqual(a.d, b.d);
});

// A fake world: Workers with their secret names, the Cloudflare API, and a log that records masks and output.
function world({ secrets = {}, apiFails = false } = {}) {
  const w = { masked: [], output: [], puts: [], requests: [], secrets };
  w.deps = {
    configs: {
      account: ACCOUNT_CONFIG,
      calls: ACCOUNT_CONFIG.replace("wrangler.jsonc", "services/calls/wrangler.jsonc"),
    },
    accountId: "acc123",
    apiToken: "cf-token",
    mask: (value) => w.masked.push(value),
    log: (line) => w.output.push(line),
    listSecrets: (worker) => Promise.resolve(worker in w.secrets ? w.secrets[worker] : null),
    putSecret: (worker, name, value) => {
      // Every value must be masked before it reaches wrangler.
      assert.ok(w.masked.includes(value), `${name} masked before put`);
      w.puts.push({ worker, name, value });
      return Promise.resolve();
    },
    fetch: (url, init) => {
      w.requests.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
      if (apiFails) {
        return Promise.resolve(
          Response.json(
            { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
            { status: 403 },
          ),
        );
      }
      const result = url.endsWith("/calls/apps")
        ? { uid: "app-uid", secret: "app-secret", name: "x" }
        : { uid: "turn-uid", key: "turn-key", name: "x" };
      return Promise.resolve(Response.json({ success: true, errors: [], result }));
    },
  };
  return w;
}

test("sets the chat token key on the account Worker when it is missing", async () => {
  const w = world({ secrets: { "zapakid-api-staging": ["PLAY_INTEGRITY_CREDENTIALS"] } });
  await bootstrap("staging", "none", w.deps);
  assert.deepEqual(
    w.puts.map((p) => [p.worker, p.name]),
    [["zapakid-api-staging", "CHAT_TOKEN_SIGNING_KEY"]],
  );
  const key = JSON.parse(w.puts[0].value);
  assert.ok(w.masked.includes(key.d), "the private scalar is masked on its own too");
  assert.ok(!w.output.join("\n").includes(key.d), "never printed");
});

test("skips a key that is already set, rotates it when asked", async () => {
  const set = { "zapakid-api-staging": ["CHAT_TOKEN_SIGNING_KEY"] };
  const skip = world({ secrets: set });
  await bootstrap("staging", "none", skip.deps);
  assert.equal(skip.puts.length, 0);
  assert.match(skip.output.join("\n"), /already set/);
  const rotate = world({ secrets: set });
  await bootstrap("staging", "chat-token-key", rotate.deps);
  assert.equal(rotate.puts.length, 1);
});

test("creates the Realtime app and TURN key zapakid-<env> and puts all four into the calls Worker, masked", async () => {
  const w = world({ secrets: { "zapakid-api-production": ["CHAT_TOKEN_SIGNING_KEY"], "calls-production": [] } });
  w.deps.configs.calls = ACCOUNT_CONFIG; // a stand-in config whose Worker is called zapakid-api-production
  w.secrets["zapakid-api-production"] = ["CHAT_TOKEN_SIGNING_KEY"];
  await bootstrap("production", "realtime", w.deps);
  assert.deepEqual(
    w.requests.map((r) => [r.url, r.auth, r.body]),
    [
      [
        "https://api.cloudflare.com/client/v4/accounts/acc123/calls/apps",
        "Bearer cf-token",
        { name: "zapakid-production" },
      ],
      [
        "https://api.cloudflare.com/client/v4/accounts/acc123/calls/turn_keys",
        "Bearer cf-token",
        { name: "zapakid-production" },
      ],
    ],
  );
  const realtime = Object.fromEntries(
    w.puts.filter((p) => REALTIME_SECRETS.includes(p.name)).map((p) => [p.name, p.value]),
  );
  assert.deepEqual(realtime, {
    REALTIME_APP_ID: "app-uid",
    REALTIME_APP_SECRET: "app-secret",
    TURN_KEY_ID: "turn-uid",
    TURN_KEY_API_TOKEN: "turn-key",
  });
  for (const value of Object.values(realtime)) assert.ok(w.masked.includes(value));
});

test("does not create a Realtime app when the calls Worker already has all four", async () => {
  const w = world();
  w.deps.configs.calls = ACCOUNT_CONFIG;
  w.secrets["zapakid-api-staging"] = ["CHAT_TOKEN_SIGNING_KEY", ...REALTIME_SECRETS];
  await bootstrap("staging", "none", w.deps);
  assert.equal(w.requests.length, 0);
  assert.equal(w.puts.length, 0);
});

test("skips, with a notice, a Worker whose config isn't on this branch or that isn't deployed yet", async () => {
  const w = world();
  w.deps.configs.calls = MISSING_CONFIG;
  await bootstrap("staging", "none", w.deps);
  const out = w.output.join("\n");
  assert.match(out, /::notice::account Worker: zapakid-api-staging is not deployed yet/);
  assert.match(out, /::notice::calls Worker: .* is not on this branch yet/);
  assert.equal(w.puts.length, 0);
});

test("a Cloudflare API failure names the status and Cloudflare's message, and puts nothing", async () => {
  const w = world({ apiFails: true });
  w.deps.configs.calls = ACCOUNT_CONFIG;
  w.secrets["zapakid-api-staging"] = ["CHAT_TOKEN_SIGNING_KEY"];
  await assert.rejects(
    bootstrap("staging", "none", w.deps),
    /Creating the Realtime app failed: HTTP 403 \(10000: Authentication error\)/,
  );
  assert.equal(w.puts.length, 0);
});

test("refuses an unknown environment or rotate value", async () => {
  await assert.rejects(bootstrap("dev", "none", world().deps), /env/);
  await assert.rejects(bootstrap("staging", "everything", world().deps), /rotate/);
});

// Regression: staging run 40580172197. A failed deploy had rolled back, so the Worker's latest version wasn't the
// deployed one and `wrangler secret put` refused (code 10215). The secret then goes on a new version instead
// (`wrangler versions secret put`), which the next deploy inherits.
test("falls back to versions secret put when the latest version isn't deployed; value on stdin only", async () => {
  const calls = [];
  const run = (args, input) => {
    calls.push({ args, input });
    return Promise.resolve(
      args[0] === "secret"
        ? { code: 1, out: "", err: "✘ [ERROR] Secret edit failed. ... isn't currently deployed. [code: 10215]" }
        : { code: 0, out: "", err: "" },
    );
  };
  const how = await putSecretWith(run, "zapakid-api-staging", "CHAT_TOKEN_SIGNING_KEY", "s3cret");
  assert.equal(how, "version");
  assert.deepEqual(calls[0].args, ["secret", "put", "CHAT_TOKEN_SIGNING_KEY", "--name", "zapakid-api-staging"]);
  assert.deepEqual(calls[1].args, [
    "versions",
    "secret",
    "put",
    "CHAT_TOKEN_SIGNING_KEY",
    "--name",
    "zapakid-api-staging",
    "--message",
    "bootstrap-secrets: CHAT_TOKEN_SIGNING_KEY",
  ]);
  assert.ok(calls.every((c) => c.input === "s3cret" && !c.args.includes("s3cret")));
});

test("a deployed Worker gets the secret directly", async () => {
  const run = () => Promise.resolve({ code: 0, out: "", err: "" });
  assert.equal(await putSecretWith(run, "w", "N", "v"), "deployed");
});

test("any other wrangler failure names wrangler's error codes, never its output", async () => {
  const run = () => Promise.resolve({ code: 1, out: "leaky v", err: "✘ [ERROR] Authentication error [code: 10000]" });
  await assert.rejects(putSecretWith(run, "w", "N", "v"), (e) => {
    assert.match(e.message, /wrangler secret put N --name w failed \(exit 1; code 10000\)/);
    assert.ok(!e.message.includes("leaky"));
    return true;
  });
});
