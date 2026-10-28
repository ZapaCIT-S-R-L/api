// Membership events reach the chat service on staging and production. Staging had no MEMBERSHIP_EVENTS producer
// (queues aren't inherited by wrangler environments), so every event stayed in the outbox and the chat service
// knew no families: "You can't start a chat with these people." Migration 0013 re-emits the current state of
// families, connections and devices that existed before events were sent; consumers apply them idempotently.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { experimental_readRawConfig } from "wrangler";

const { rawConfig } = experimental_readRawConfig({ config: "wrangler.jsonc" });
const chat = experimental_readRawConfig({ config: "services/chat/wrangler.jsonc" }).rawConfig;

for (const name of ["staging", "production"]) {
  test(`${name} sends membership events to the queue the ${name} chat service consumes`, () => {
    const producers = rawConfig.env[name].queues?.producers ?? [];
    const queue = producers.find((p) => p.binding === "MEMBERSHIP_EVENTS")?.queue;
    assert.equal(queue, `zapakid-membership-${name}`);
    const consumers = (chat.env[name].queues?.consumers ?? []).map((c) => c.queue);
    assert.ok(consumers.includes(queue), `chat ${name} consumes ${queue}`);
  });
}

const dir = new URL("../../migrations/", import.meta.url);
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const target = files.find((f) => f.startsWith("0013_"));

function apply(db, file) {
  db.exec("BEGIN");
  db.exec(readFileSync(new URL(file, dir), "utf8"));
  db.exec("COMMIT");
}

function seededBefore() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of files.filter((f) => f < "0013_")) apply(db, f);
  const now = new Date().toISOString();
  for (const id of ["p1", "p2"]) {
    db.prepare(
      `INSERT INTO parents (id, age_category, age_source, age_checked_at, created_at, updated_at)
       VALUES (?, 'adult', 'apple_declared_age_range', ?, ?, ?)`,
    ).run(id, now, now, now);
  }
  for (const id of ["f1", "f2"])
    db.prepare("INSERT INTO families (id, name, created_at) VALUES (?, NULL, ?)").run(id, now);
  db.prepare("INSERT INTO family_parents (family_id, parent_id, joined_at) VALUES ('f1', 'p1', ?)").run(now);
  db.prepare("INSERT INTO family_parents (family_id, parent_id, joined_at) VALUES ('f2', 'p2', ?)").run(now);
  db.prepare(
    "INSERT INTO kids (id, family_id, nickname, avatar, created_at, updated_at) VALUES ('k1', 'f1', 'Theo', 'r', ?, ?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO family_connections (id, family_a, family_b, created_by, created_at) VALUES ('c1', 'f1', 'f2', 'p1', ?)",
  ).run(now);
  db.prepare(
    "INSERT INTO connection_shared_kids (connection_id, kid_id, shared_by, shared_at) VALUES ('c1', 'k1', 'p1', ?)",
  ).run(now);
  db.prepare(`INSERT INTO devices VALUES ('p1', 1, 42, 1, 'SPK', 'SIG', 1, 'PQ', 'PQSIG', NULL, ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO devices VALUES ('k1', 1, 43, 1, 'SPK', 'SIG', 1, 'PQ', 'PQSIG', NULL, ?, ?)`).run(now, now);
  return db;
}

const events = (db) =>
  db
    .prepare("SELECT body, created_at, sent_at FROM membership_outbox ORDER BY seq")
    .all()
    .map((r) => ({ ...JSON.parse(r.body), row: r }));

test("migration 0013 exists", () => {
  assert.ok(target, "migrations/0013_*.sql");
});

test("0013 re-emits every family member, connection, shared kid and device, in that order", { skip: !target }, () => {
  const db = seededBefore();
  apply(db, target);
  const all = events(db);
  const strip = (e) =>
    Object.fromEntries(Object.entries(e).filter(([k]) => !["v", "id", "occurredAt", "row"].includes(k)));
  assert.deepEqual(all.map(strip), [
    { type: "family.member_added", familyId: "f1", accountId: "p1", role: "parent" },
    { type: "family.member_added", familyId: "f2", accountId: "p2", role: "parent" },
    { type: "family.member_added", familyId: "f1", accountId: "k1", role: "kid" },
    { type: "connection.created", connectionId: "c1", familyIds: ["f1", "f2"] },
    { type: "connection.kid_shared", connectionId: "c1", kidAccountId: "k1" },
    { type: "device.upserted", accountId: "k1", deviceId: 1, registrationId: 43 },
    { type: "device.upserted", accountId: "p1", deviceId: 1, registrationId: 42 },
  ]);
  for (const e of all) {
    assert.equal(e.v, 1);
    assert.match(e.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(!Number.isNaN(Date.parse(e.occurredAt)));
    assert.equal(e.row.sent_at, null);
  }
  assert.equal(new Set(all.map((e) => e.id)).size, all.length);
});

test("0013 on an empty database emits nothing", { skip: !target }, () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of files) apply(db, f);
  assert.equal(events(db).length, 0);
});
