// The daily cron deletes expired sessions and sign-in nonces, and keeps the live ones.
import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { ONE_TIME_ROW_ALERT } from "../../src/purge";
import worker from "../../src/index";
import { count } from "./helpers";

const past = () => new Date(Date.now() - 1000).toISOString();
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const hex = (c: string) => c.repeat(64);

async function runCron() {
  await worker.scheduled(createScheduledController({ cron: "17 * * * *" }), env);
}

describe("daily purge", () => {
  it("deletes expired sessions and keeps live ones", async () => {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO parents (id, age_category, age_source, age_checked_at, created_at, updated_at)
         VALUES ('p1', 'adult', 'apple_declared_age_range', ?, ?, ?)`,
      ).bind(now, now, now),
      env.DB.prepare(
        "INSERT INTO sessions (token_hash, parent_id, created_at, expires_at) VALUES (?, 'p1', ?, ?)",
      ).bind(hex("a"), now, past()),
      env.DB.prepare(
        "INSERT INTO sessions (token_hash, parent_id, created_at, expires_at) VALUES (?, 'p1', ?, ?)",
      ).bind(hex("b"), now, future()),
    ]);
    await runCron();
    const rows = await env.DB.prepare("SELECT token_hash FROM sessions").all<{ token_hash: string }>();
    expect(rows.results.map((r) => r.token_hash)).toEqual([hex("b")]);
    expect(await count("parents")).toBe(1);
  });

  it("deletes expired nonces and keeps live ones", async () => {
    await env.DB.prepare("DELETE FROM sign_in_nonces").run();
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sign_in_nonces VALUES (?, ?, ?)").bind(hex("c"), now, past()),
      env.DB.prepare("INSERT INTO sign_in_nonces VALUES (?, ?, ?)").bind(hex("d"), now, future()),
    ]);
    await runCron();
    const rows = await env.DB.prepare("SELECT nonce_hash FROM sign_in_nonces").all<{ nonce_hash: string }>();
    expect(rows.results.map((r) => r.nonce_hash)).toEqual([hex("d")]);
  });

  it("deletes expired Apple web flows, keeps a live code", async () => {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO apple_web_flows (state_hash, code_challenge, created_at, expires_at) VALUES (?, 'c', ?, ?)",
      ).bind(hex("e"), now, past()),
      env.DB.prepare(
        "INSERT INTO apple_web_flows (state_hash, code_challenge, created_at, expires_at, code_expires_at) VALUES (?, 'c', ?, ?, ?)",
      ).bind(hex("f"), now, past(), future()),
      env.DB.prepare(
        "INSERT INTO apple_web_flows (state_hash, code_challenge, created_at, expires_at) VALUES (?, 'c', ?, ?)",
      ).bind(hex("0"), now, future()),
    ]);
    await runCron();
    const rows = await env.DB.prepare("SELECT state_hash FROM apple_web_flows ORDER BY state_hash").all<{
      state_hash: string;
    }>();
    expect(rows.results.map((r) => r.state_hash)).toEqual([hex("0"), hex("f")]);
  });

  it("deletes App Attest keys unused for 180 days, keeps recent ones", async () => {
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    const key = (id: string, created: string, used: string | null) =>
      env.DB.prepare(
        "INSERT INTO app_attest_keys (key_id, public_key, counter, environment, created_at, last_used_at) VALUES (?, 'pk', 1, 'production', ?, ?)",
      ).bind(id, created, used);
    await env.DB.batch([
      key("used-long-ago", daysAgo(400), daysAgo(181)),
      key("never-used-old", daysAgo(181), null),
      key("used-recently", daysAgo(400), daysAgo(10)),
      key("new-unused", daysAgo(10), null),
    ]);
    await runCron();
    const rows = await env.DB.prepare("SELECT key_id FROM app_attest_keys ORDER BY key_id").all<{ key_id: string }>();
    expect(rows.results.map((r) => r.key_id)).toEqual(["new-unused", "used-recently"]);
  });

  it("deletes expired App Attest challenges, keeps live ones", async () => {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO app_attest_challenges VALUES (?, ?, ?)").bind(hex("1"), now, past()),
      env.DB.prepare("INSERT INTO app_attest_challenges VALUES (?, ?, ?)").bind(hex("2"), now, future()),
    ]);
    await runCron();
    const rows = await env.DB.prepare("SELECT challenge_hash FROM app_attest_challenges").all<{
      challenge_hash: string;
    }>();
    expect(rows.results.map((r) => r.challenge_hash)).toEqual([hex("2")]);
  });

  it("deletes expired family invitations (used or not), keeps live ones", async () => {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO parents (id, age_category, age_source, age_checked_at, created_at, updated_at)
         VALUES ('p1', 'adult', 'apple_declared_age_range', ?, ?, ?)`,
      ).bind(now, now, now),
      env.DB.prepare("INSERT INTO families (id, name, created_at) VALUES ('f1', NULL, ?)").bind(now),
      env.DB.prepare(
        "INSERT INTO family_invitations (code_hash, family_id, created_by, created_at, expires_at) VALUES (?, 'f1', 'p1', ?, ?)",
      ).bind(hex("3"), now, past()),
      env.DB.prepare(
        "INSERT INTO family_invitations (code_hash, family_id, created_by, created_at, expires_at) VALUES (?, 'f1', 'p1', ?, ?)",
      ).bind(hex("4"), now, future()),
    ]);
    await runCron();
    const rows = await env.DB.prepare("SELECT code_hash FROM family_invitations").all<{ code_hash: string }>();
    expect(rows.results.map((r) => r.code_hash)).toEqual([hex("4")]);
  });

  it("deletes expired kid pairing codes and kid sessions, keeps live ones", async () => {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO parents (id, age_category, age_source, age_checked_at, created_at, updated_at)
         VALUES ('p1', 'adult', 'apple_declared_age_range', ?, ?, ?)`,
      ).bind(now, now, now),
      env.DB.prepare("INSERT INTO families (id, name, created_at) VALUES ('f1', NULL, ?)").bind(now),
      env.DB.prepare(
        "INSERT INTO kids (id, family_id, nickname, avatar, created_at, updated_at) VALUES ('k1', 'f1', 'M', 'r', ?, ?)",
      ).bind(now, now),
      ...[
        [hex("5"), past()],
        [hex("6"), future()],
      ].flatMap(([h, exp]) => [
        env.DB.prepare(
          "INSERT INTO kid_pairings (code_hash, kid_id, family_id, created_by, created_at, expires_at) VALUES (?, 'k1', 'f1', 'p1', ?, ?)",
        ).bind(h, now, exp),
        env.DB.prepare(
          "INSERT INTO kid_sessions (token_hash, kid_id, created_at, expires_at) VALUES (?, 'k1', ?, ?)",
        ).bind(h, now, exp),
      ]),
    ]);
    await runCron();
    const codes = await env.DB.prepare("SELECT code_hash FROM kid_pairings").all<{ code_hash: string }>();
    expect(codes.results.map((r) => r.code_hash)).toEqual([hex("6")]);
    const sessions = await env.DB.prepare("SELECT token_hash FROM kid_sessions").all<{ token_hash: string }>();
    expect(sessions.results.map((r) => r.token_hash)).toEqual([hex("6")]);
  });

  it("deletes expired connection invitations, keeps live ones", async () => {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO parents (id, age_category, age_source, age_checked_at, created_at, updated_at)
         VALUES ('p1', 'adult', 'apple_declared_age_range', ?, ?, ?)`,
      ).bind(now, now, now),
      env.DB.prepare("INSERT INTO families (id, name, created_at) VALUES ('f1', NULL, ?)").bind(now),
      ...[
        [hex("7"), past()],
        [hex("8"), future()],
      ].map(([h, exp]) =>
        env.DB.prepare(
          "INSERT INTO connection_invitations (code_hash, family_id, created_by, created_at, expires_at) VALUES (?, 'f1', 'p1', ?, ?)",
        ).bind(h, now, exp),
      ),
    ]);
    await runCron();
    const rows = await env.DB.prepare("SELECT code_hash FROM connection_invitations").all<{ code_hash: string }>();
    expect(rows.results.map((r) => r.code_hash)).toEqual([hex("8")]);
  });

  // Regression (security review 2026-10-27, L7): a flood of live one-time rows (nonces, web flows, attestation
  // challenges) between purges is reported, so it can be alerted on.
  it("logs an alert when a one-time table holds more than ONE_TIME_ROW_ALERT live rows", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i <= ?)
       INSERT INTO sign_in_nonces (nonce_hash, created_at, expires_at)
       SELECT printf('%064x', i), ?, ? FROM n`,
    )
      .bind(ONE_TIME_ROW_ALERT, new Date().toISOString(), future())
      .run();
    await runCron();
    const alerts = error.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("one-time rows over the alert"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("sign_in_nonces");
    error.mockRestore();
  });

  it("does nothing on an empty database", async () => {
    await env.DB.prepare("DELETE FROM sign_in_nonces").run();
    await runCron();
    expect(await count("sessions")).toBe(0);
  });
});
