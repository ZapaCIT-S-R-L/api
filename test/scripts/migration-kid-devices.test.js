// Migration 0011 (kid devices) on a database that already has parent devices: it rebuilds the key directory
// tables without the foreign key to parents (kids are accounts too) and must keep every row, the prekey cascade
// from devices, and the cleanup when a parent or kid row goes. Runs the real migration files on SQLite with foreign
// keys on, as D1 does, each file in one transaction.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const dir = new URL("../../migrations/", import.meta.url);
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const target = files.find((f) => f.startsWith("0011_"));

function apply(db, file) {
  db.exec("BEGIN");
  db.exec(readFileSync(new URL(file, dir), "utf8"));
  db.exec("COMMIT");
}

function seededBefore() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of files.filter((f) => f < "0011_")) apply(db, f);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO parents (id, age_category, age_source, age_checked_at, created_at, updated_at)
     VALUES ('p1', 'adult', 'apple_declared_age_range', ?, ?, ?)`,
  ).run(now, now, now);
  db.prepare(
    "INSERT INTO sessions (token_hash, parent_id, created_at, expires_at, device_id) VALUES (?, 'p1', ?, ?, 1)",
  ).run("a".repeat(64), now, now);
  db.prepare("INSERT INTO account_identities VALUES ('p1', 'IK', ?)").run(now);
  db.prepare("INSERT INTO identity_key_changes VALUES ('p1', 'OLD', 'IK', NULL, ?)").run(now);
  db.prepare(`INSERT INTO devices VALUES ('p1', 1, 42, 1, 'SPK', 'SIG', 1, 'PQ', 'PQSIG', 'push', ?, ?)`).run(now, now);
  db.prepare("INSERT INTO one_time_prekeys VALUES ('p1', 1, 7, 'OTK')").run();
  db.prepare("INSERT INTO pq_one_time_prekeys VALUES ('p1', 1, 8, 'PQOTK', 'PQOTKSIG')").run();
  db.prepare("INSERT INTO families (id, name, created_at) VALUES ('f1', NULL, ?)").run(now);
  db.prepare(
    "INSERT INTO kids (id, family_id, nickname, avatar, created_at, updated_at) VALUES ('k1', 'f1', 'Mia', 'r', ?, ?)",
  ).run(now, now);
  db.prepare("INSERT INTO kid_sessions (token_hash, kid_id, created_at, expires_at) VALUES (?, 'k1', ?, ?)").run(
    "b".repeat(64),
    now,
    now,
  );
  return db;
}

const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all();

test("migration 0011 exists", () => {
  assert.ok(target, "migrations/0011_*.sql");
});

test("0011 keeps every existing key directory row", { skip: !target }, () => {
  const db = seededBefore();
  const tables = ["devices", "one_time_prekeys", "pq_one_time_prekeys", "account_identities", "identity_key_changes"];
  const before = Object.fromEntries(tables.map((t) => [t, rows(db, t)]));
  apply(db, target);
  for (const t of tables) assert.deepEqual(rows(db, t), before[t], `${t} changed`);
  assert.equal(db.prepare("SELECT device_id FROM sessions").get().device_id, 1);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("after 0011 a kid has devices, identities and a bound kid session", { skip: !target }, () => {
  const db = seededBefore();
  apply(db, target);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO account_identities VALUES ('k1', 'KIK', ?)").run(now);
  db.prepare(`INSERT INTO devices VALUES ('k1', 1, 43, 1, 'SPK', 'SIG', 1, 'PQ', 'PQSIG', NULL, ?, ?)`).run(now, now);
  db.prepare("INSERT INTO one_time_prekeys VALUES ('k1', 1, 7, 'OTK')").run();
  db.prepare("UPDATE kid_sessions SET device_id = 1").run();
  assert.equal(db.prepare("SELECT count(*) AS n FROM devices").get().n, 2);
});

test(
  "after 0011 prekeys still cascade from devices, and accounts' rows go with the parent or kid",
  { skip: !target },
  () => {
    const db = seededBefore();
    apply(db, target);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO devices VALUES ('k1', 1, 43, 1, 'SPK', 'SIG', 1, 'PQ', 'PQSIG', NULL, ?, ?)`).run(now, now);
    db.prepare("INSERT INTO account_identities VALUES ('k1', 'KIK', ?)").run(now);
    db.prepare("INSERT INTO one_time_prekeys VALUES ('k1', 1, 7, 'OTK')").run();

    db.prepare("DELETE FROM devices WHERE account_id = 'k1'").run();
    assert.equal(db.prepare("SELECT count(*) AS n FROM one_time_prekeys WHERE account_id = 'k1'").get().n, 0);

    db.prepare(`INSERT INTO devices VALUES ('k1', 1, 43, 1, 'SPK', 'SIG', 1, 'PQ', 'PQSIG', NULL, ?, ?)`).run(now, now);
    db.prepare("DELETE FROM families WHERE id = 'f1'").run();
    for (const t of ["devices", "account_identities"]) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${t} WHERE account_id = 'k1'`).get().n, 0, t);
    }

    db.prepare("DELETE FROM parents WHERE id = 'p1'").run();
    for (const t of [
      "devices",
      "one_time_prekeys",
      "pq_one_time_prekeys",
      "account_identities",
      "identity_key_changes",
    ]) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0, t);
    }
  },
);
