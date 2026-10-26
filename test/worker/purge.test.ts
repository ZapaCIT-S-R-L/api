// The daily cron deletes expired sessions and sign-in nonces, and keeps the live ones.
import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { count } from "./helpers";

const past = () => new Date(Date.now() - 1000).toISOString();
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const hex = (c: string) => c.repeat(64);

async function runCron() {
  await worker.scheduled(createScheduledController({ cron: "17 3 * * *" }), env);
}

describe("daily purge", () => {
  it("deletes expired sessions and keeps live ones", async () => {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO parents (id, age_category, age_source, age_checked_at, created_at, updated_at)
         VALUES ('p1', 'adult', 'apple_declared_age_range', ?, ?, ?)`,
      ).bind(now, now, now),
      env.DB.prepare("INSERT INTO sessions VALUES (?, 'p1', ?, ?)").bind(hex("a"), now, past()),
      env.DB.prepare("INSERT INTO sessions VALUES (?, 'p1', ?, ?)").bind(hex("b"), now, future()),
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

  it("does nothing on an empty database", async () => {
    await env.DB.prepare("DELETE FROM sign_in_nonces").run();
    await runCron();
    expect(await count("sessions")).toBe(0);
  });
});
