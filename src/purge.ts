// Hourly cron (wrangler.jsonc triggers): deletes expired sessions, sign-in nonces, Apple web flows, App Attest
// challenges, family invitations, kid pairing codes and kid sessions, App Attest keys unused for 180 days, and devices
// inactive for 90 days. Data minimisation, and it keeps the one-time tables small however many are requested.
import { DEVICE_INACTIVE_DAYS } from "./devices";
import type { Env } from "./env";

// An App Attest key not used for this long is deleted. The app then gets 403 attestation_failed once, forgets the
// key and registers a new one (ios AppAttestor.reset), so this costs nothing and keeps no stale device keys.
export const APP_ATTEST_KEY_RETENTION_DAYS = 180;

// Unauthenticated endpoints add one-time rows (rate limited per network, purged hourly). More live rows than this
// in one table means a flood: it is logged as an error for alerting.
export const ONE_TIME_ROW_ALERT = 10_000;
const ONE_TIME_TABLES = ["sign_in_nonces", "apple_web_flows", "app_attest_challenges"] as const;

export async function purgeExpired(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const keyCutoff = new Date(Date.now() - APP_ATTEST_KEY_RETENTION_DAYS * 86_400_000).toISOString();
  const deviceCutoff = new Date(Date.now() - DEVICE_INACTIVE_DAYS * 86_400_000).toISOString();
  const [sessions, nonces, flows, challenges, keys, devices, , invitations, pairings, kidSessions] = await env.DB.batch(
    [
      env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
      env.DB.prepare("DELETE FROM sign_in_nonces WHERE expires_at <= ?").bind(now),
      // A flow lives 10 minutes; a code issued near its end lives at most 2 more.
      env.DB.prepare(
        "DELETE FROM apple_web_flows WHERE expires_at <= ? AND (code_expires_at IS NULL OR code_expires_at <= ?)",
      ).bind(now, now),
      env.DB.prepare("DELETE FROM app_attest_challenges WHERE expires_at <= ?").bind(now),
      env.DB.prepare("DELETE FROM app_attest_keys WHERE coalesce(last_used_at, created_at) <= ?").bind(keyCutoff),
      // Devices without a request for 90 days go, with their prekeys (cascade), and their sessions are signed out.
      env.DB.prepare("DELETE FROM devices WHERE last_seen_at <= ?").bind(deviceCutoff),
      env.DB.prepare(
        `DELETE FROM sessions WHERE device_id IS NOT NULL AND NOT EXISTS
         (SELECT 1 FROM devices d WHERE d.account_id = sessions.parent_id AND d.device_id = sessions.device_id)`,
      ),
      env.DB.prepare("DELETE FROM family_invitations WHERE expires_at <= ?").bind(now),
      env.DB.prepare("DELETE FROM kid_pairings WHERE expires_at <= ?").bind(now),
      env.DB.prepare("DELETE FROM kid_sessions WHERE expires_at <= ?").bind(now),
    ],
  );
  const counts = await env.DB.batch<{ n: number }>(
    ONE_TIME_TABLES.map((table) => env.DB.prepare(`SELECT count(*) AS n FROM ${table}`)),
  );
  ONE_TIME_TABLES.forEach((table, i) => {
    const rows = counts[i]?.results[0]?.n ?? 0;
    if (rows > ONE_TIME_ROW_ALERT) {
      console.error(JSON.stringify({ msg: "one-time rows over the alert threshold", table, rows }));
    }
  });
  console.log(
    JSON.stringify({
      msg: "purged expired",
      sessions: sessions?.meta.changes ?? 0,
      nonces: nonces?.meta.changes ?? 0,
      appleWebFlows: flows?.meta.changes ?? 0,
      appAttestChallenges: challenges?.meta.changes ?? 0,
      appAttestKeys: keys?.meta.changes ?? 0,
      devices: devices?.meta.changes ?? 0,
      familyInvitations: invitations?.meta.changes ?? 0,
      kidPairings: pairings?.meta.changes ?? 0,
      kidSessions: kidSessions?.meta.changes ?? 0,
    }),
  );
}
