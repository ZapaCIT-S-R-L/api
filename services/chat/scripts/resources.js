// Finds or creates the Cloudflare resources of a deployed chat environment, then writes the D1 database id into
// wrangler.jsonc in place of that environment's placeholder (the real id is never committed):
//   D1 database zapakid-chat-<env> (EU jurisdiction)
//   R2 bucket zapakid-chat-attachments-<env> (EU jurisdiction)
//   Queues zapakid-membership-<env> and zapakid-membership-<env>-dlq (the account service produces into the first),
//   zapakid-conversation-events-<env> and its -dlq (this service produces, the calls service consumes; the calls
//   deploy creates them too, so either service can go first)
// Runs in the deploy workflows only, before the D1 migrations and the deploy, with the environment's token.
// CLI: node scripts/resources.js staging|production
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PLACEHOLDERS = {
  staging: "00000000-0000-0000-0000-000000000001",
  production: "00000000-0000-0000-0000-000000000002",
};

export function names(env) {
  if (!Object.hasOwn(PLACEHOLDERS, env)) throw new Error(`unknown environment "${env}"`);
  return {
    database: `zapakid-chat-${env}`,
    bucket: `zapakid-chat-attachments-${env}`,
    queues: [
      `zapakid-membership-${env}`,
      `zapakid-membership-${env}-dlq`,
      `zapakid-conversation-events-${env}`,
      `zapakid-conversation-events-${env}-dlq`,
    ],
  };
}

// The database called `name` in `wrangler d1 list --json` output. Refuses one outside the EU jurisdiction.
export function findDatabase(list, name) {
  const matches = list.filter((db) => db.name === name);
  if (matches.length > 1) throw new Error(`more than one D1 database named ${name}`);
  const db = matches[0];
  if (!db) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(db.uuid ?? "")) {
    throw new Error(`D1 database ${name} has no valid uuid`);
  }
  if (db.jurisdiction !== undefined && db.jurisdiction !== "eu") {
    throw new Error(`D1 database ${name} is in jurisdiction "${db.jurisdiction}", not "eu"`);
  }
  return db;
}

// wrangler.jsonc with the environment's placeholder replaced by the real id. The placeholder must occur once.
export function patchConfig(text, env, uuid) {
  const needle = `"database_id": "${PLACEHOLDERS[env]}"`;
  const count = text.split(needle).length - 1;
  if (count !== 1)
    throw new Error(`expected the ${env} placeholder database_id once in wrangler.jsonc, found ${count}`);
  return text.replace(needle, `"database_id": "${uuid}"`);
}

function wrangler(args) {
  return execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function exists(args) {
  try {
    execFileSync("npx", ["wrangler", ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.argv[2];
  const { database, bucket, queues } = names(env);

  const list = () => JSON.parse(wrangler(["d1", "list", "--json"]));
  let db = findDatabase(list(), database);
  if (!db) {
    console.log(`Creating D1 database ${database} in the EU jurisdiction`);
    wrangler(["d1", "create", database, "--jurisdiction", "eu", "--no-update-config"]);
    db = findDatabase(list(), database);
    if (!db) throw new Error(`D1 database ${database} not found after creating it`);
  }
  if (db.jurisdiction === undefined) console.log(`::warning::wrangler did not report the jurisdiction of ${database}`);
  const path = new URL("../wrangler.jsonc", import.meta.url);
  writeFileSync(path, patchConfig(readFileSync(path, "utf8"), env, db.uuid));
  console.log(`D1 ${database}: ${db.uuid}`);

  if (!exists(["r2", "bucket", "info", bucket, "--jurisdiction", "eu"])) {
    console.log(`Creating R2 bucket ${bucket} in the EU jurisdiction`);
    wrangler(["r2", "bucket", "create", bucket, "--jurisdiction", "eu"]);
  }

  for (const queue of queues) {
    if (exists(["queues", "info", queue])) continue;
    console.log(`Creating queue ${queue}`);
    wrangler(["queues", "create", queue]);
  }
}
