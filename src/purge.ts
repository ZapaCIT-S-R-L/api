// Daily cron (wrangler.jsonc triggers): deletes expired sessions, sign-in nonces and Apple web flows. Data minimisation, and it
// keeps the nonce table small however many nonces are requested.
import type { Env } from "./env";

export async function purgeExpired(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const [sessions, nonces, flows] = await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM sign_in_nonces WHERE expires_at <= ?").bind(now),
    // A flow lives 10 minutes; a code issued near its end lives at most 2 more.
    env.DB.prepare(
      "DELETE FROM apple_web_flows WHERE expires_at <= ? AND (code_expires_at IS NULL OR code_expires_at <= ?)",
    ).bind(now, now),
  ]);
  console.log(
    JSON.stringify({
      msg: "purged expired",
      sessions: sessions?.meta.changes ?? 0,
      nonces: nonces?.meta.changes ?? 0,
      appleWebFlows: flows?.meta.changes ?? 0,
    }),
  );
}
