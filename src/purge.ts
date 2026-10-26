// Daily cron (wrangler.jsonc triggers): deletes expired sessions and sign-in nonces. Data minimisation, and it
// keeps the nonce table small however many nonces are requested.
import type { Env } from "./env";

export async function purgeExpired(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const [sessions, nonces] = await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM sign_in_nonces WHERE expires_at <= ?").bind(now),
  ]);
  console.log(
    JSON.stringify({ msg: "purged expired", sessions: sessions?.meta.changes ?? 0, nonces: nonces?.meta.changes ?? 0 }),
  );
}
