// Creates and stores the Workers' generated secrets for one environment. Runs only in the bootstrap-secrets workflow
// (Actions → bootstrap-secrets → Run workflow, protected `staging`/`production` environment), never on a laptop.
//   account Worker (wrangler.jsonc):             CHAT_TOKEN_SIGNING_KEY, a new ES256 key pair made here
//   calls Worker (services/calls/wrangler.jsonc): REALTIME_APP_ID, REALTIME_APP_SECRET (a new Realtime SFU app) and
//                                                TURN_KEY_ID, TURN_KEY_API_TOKEN (a new TURN key), both "zapakid-<env>"
// Idempotent: a group whose secrets are all on the Worker already is skipped, unless ROTATE names it (or "all").
// A Worker that isn't deployed yet (or whose config isn't on this branch) is skipped with a notice.
// No value is ever printed, logged or written to disk: each is masked (::add-mask::) the moment it exists and goes to
// `wrangler secret put` on stdin. Errors name the step and the HTTP status, never a response body with a value in it.
// CLI: node scripts/bootstrap-secrets.js staging|production   (env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, ROTATE)
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";
import { experimental_readRawConfig } from "wrangler";

export const ENVIRONMENTS = ["staging", "production"];
export const ROTATE = ["none", "chat-token-key", "realtime", "all"];
export const CHAT_SECRETS = ["CHAT_TOKEN_SIGNING_KEY"];
export const REALTIME_SECRETS = ["REALTIME_APP_ID", "REALTIME_APP_SECRET", "TURN_KEY_ID", "TURN_KEY_API_TOKEN"];
const API = "https://api.cloudflare.com/client/v4";

// The deployed Worker's name for an environment, from its wrangler config: the environment's own `name`, else
// "<name>-<env>" (wrangler's rule). Null when the config isn't there (the service isn't on this branch yet).
export function workerName(configPath, env) {
  if (!existsSync(configPath)) return null;
  const { rawConfig } = experimental_readRawConfig({ config: configPath });
  return rawConfig.env?.[env]?.name ?? `${rawConfig.name}-${env}`;
}

// The secret names in `wrangler secret list --format json` output.
export function secretNames(json) {
  const list = JSON.parse(json);
  if (!Array.isArray(list)) throw new Error("wrangler secret list did not return a list");
  return list.map((s) => s.name);
}

// What to do with a group of secrets: "create" (some missing), "rotate" (all there, rotation asked) or "skip".
export function decide(existing, names, group, rotate) {
  if (names.some((n) => !existing.includes(n))) return "create";
  return rotate === group || rotate === "all" ? "rotate" : "skip";
}

// A new chat token signing key: a private P-256 JWK with its RFC 7638 thumbprint as kid (api: src/chat-token.ts).
export async function newChatTokenKey() {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
  return JSON.stringify({ ...jwk, kid, alg: "ES256", use: "sig" });
}

// POSTs to the Cloudflare API and returns `result`. On failure: the status and Cloudflare's error messages only.
async function cloudflare(deps, path, body, what) {
  const res = await deps.fetch(`${API}/accounts/${deps.accountId}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${deps.apiToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success || !json.result) {
    const messages = (json?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`${what} failed: HTTP ${res.status}${messages ? ` (${messages})` : ""}`);
  }
  return json.result;
}

// A new Realtime SFU app and TURN key, every value masked before it is returned.
export async function newRealtimeCredentials(deps, env) {
  const name = `zapakid-${env}`;
  const app = await cloudflare(deps, "/calls/apps", { name }, "Creating the Realtime app");
  for (const value of [app.uid, app.secret]) deps.mask(value);
  const turn = await cloudflare(deps, "/calls/turn_keys", { name }, "Creating the TURN key");
  for (const value of [turn.uid, turn.key]) deps.mask(value);
  if (![app.uid, app.secret, turn.uid, turn.key].every((v) => typeof v === "string" && v.length > 0)) {
    throw new Error("The Cloudflare API answer is missing uid/secret/key");
  }
  return {
    REALTIME_APP_ID: app.uid,
    REALTIME_APP_SECRET: app.secret,
    TURN_KEY_ID: turn.uid,
    TURN_KEY_API_TOKEN: turn.key,
  };
}

// Runs the bootstrap for one environment. `deps` holds everything with side effects, so tests can fake them:
// listSecrets(worker) → names or null (Worker not deployed), putSecret(worker, name, value), fetch, mask, log.
export async function bootstrap(env, rotate, deps) {
  if (!ENVIRONMENTS.includes(env)) throw new Error(`env must be one of ${ENVIRONMENTS.join(", ")}`);
  if (!ROTATE.includes(rotate)) throw new Error(`rotate must be one of ${ROTATE.join(", ")}`);
  const groups = [
    {
      group: "chat-token-key",
      label: "account Worker",
      config: deps.configs.account,
      names: CHAT_SECRETS,
      make: async () => {
        const key = await newChatTokenKey();
        deps.mask(key);
        deps.mask(JSON.parse(key).d);
        return { CHAT_TOKEN_SIGNING_KEY: key };
      },
    },
    {
      group: "realtime",
      label: "calls Worker",
      config: deps.configs.calls,
      names: REALTIME_SECRETS,
      make: () => newRealtimeCredentials(deps, env),
    },
  ];
  const summary = [];
  for (const g of groups) {
    const worker = workerName(g.config, env);
    if (!worker) {
      deps.log(`::notice::${g.label}: ${g.config} is not on this branch yet; skipped ${g.names.join(", ")}.`);
      summary.push(`${g.label}: skipped (not on this branch)`);
      continue;
    }
    const existing = await deps.listSecrets(worker);
    if (existing === null) {
      deps.log(`::notice::${g.label}: ${worker} is not deployed yet; skipped. Deploy it, then run this again.`);
      summary.push(`${worker}: skipped (not deployed yet)`);
      continue;
    }
    const action = decide(existing, g.names, g.group, rotate);
    if (action === "skip") {
      deps.log(`${worker}: ${g.names.join(", ")} already set; skipped (rotate: ${g.group} to replace).`);
      summary.push(`${worker}: already set`);
      continue;
    }
    const values = await g.make();
    for (const name of g.names) await deps.putSecret(worker, name, values[name]);
    deps.log(`${worker}: ${action === "rotate" ? "rotated" : "set"} ${g.names.join(", ")}.`);
    summary.push(`${worker}: ${action === "rotate" ? "rotated" : "set"}`);
  }
  return summary;
}

// ---- The real side effects (the workflow) ----

const WRANGLER = fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url));

// Runs wrangler outside any project folder (--name picks the Worker), with `input` on stdin.
function wrangler(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(WRANGLER, args, { cwd: process.env.RUNNER_TEMP ?? "/tmp", stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(input ?? "");
  });
}

async function listSecrets(worker) {
  const { code, out, err } = await wrangler(["secret", "list", "--name", worker, "--format", "json"]);
  if (code === 0) return secretNames(out.slice(out.indexOf("[")));
  if (/10007|not found|does not exist/i.test(out + err)) return null;
  throw new Error(`wrangler secret list --name ${worker} failed (exit ${code})`);
}

// Puts one secret through `run` (wrangler). Returns "deployed" when it went live at once, or "version" when the
// Worker's latest version isn't the deployed one (a rolled-back deploy): then it goes on a new version,
// which the next deploy inherits. The value goes on stdin only; errors carry wrangler's error codes, never its output.
export async function putSecretWith(run, worker, name, value) {
  const direct = await run(["secret", "put", name, "--name", worker], value);
  if (direct.code === 0) return "deployed";
  if (/latest version of your Worker isn't currently deployed/.test(direct.out + direct.err)) {
    const msg = `bootstrap-secrets: ${name}`;
    const viaVersion = await run(["versions", "secret", "put", name, "--name", worker, "--message", msg], value);
    if (viaVersion.code === 0) return "version";
    throw new Error(`wrangler versions secret put ${name} --name ${worker} failed (${detail(viaVersion)})`);
  }
  throw new Error(`wrangler secret put ${name} --name ${worker} failed (${detail(direct)})`);
}

function codes({ out, err }) {
  return [...`${out}\n${err}`.matchAll(/\[code: (\d+)\]/g)].map((m) => m[1]);
}

function detail(result) {
  const c = codes(result);
  return `exit ${result.code}${c.length ? `; code ${c.join(", ")}` : ""}`;
}

async function putSecret(worker, name, value) {
  if ((await putSecretWith(wrangler, worker, name, value)) === "version") {
    console.log(`::notice::${worker}: ${name} is on a new version, not live yet; re-run the Worker's deploy.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.argv[2];
  const { CLOUDFLARE_API_TOKEN: apiToken, CLOUDFLARE_ACCOUNT_ID: accountId } = process.env;
  if (!apiToken || !accountId) {
    console.error(
      "::error::Set CLOUDFLARE_API_TOKEN (secret) and CLOUDFLARE_ACCOUNT_ID (variable) on the environment.",
    );
    process.exit(1);
  }
  const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
  try {
    const summary = await bootstrap(env, process.env.ROTATE || "none", {
      configs: { account: root("wrangler.jsonc"), calls: root("services/calls/wrangler.jsonc") },
      accountId,
      apiToken,
      fetch: globalThis.fetch,
      mask: (value) => process.stdout.write(`::add-mask::${value}\n`),
      log: (line) => console.log(line),
      listSecrets,
      putSecret,
    });
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `Secrets (${env}):\n\n${summary.map((s) => `- ${s}`).join("\n")}\n`,
      );
    }
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
