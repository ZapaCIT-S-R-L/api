// Daily cron (wrangler.jsonc triggers): deletes expired sessions, sign-in nonces, Apple web flows, App Attest
// challenges, family invitations, kid pairing codes, kid sessions and sent membership events, App Attest keys unused
// for 180 days, and devices inactive for 90 days. Data minimisation, and it keeps the one-time tables small however
// many are requested.
import { DEVICE_INACTIVE_DAYS } from "./devices";
import type { Env } from "./env";
import { SENT_RETENTION_DAYS } from "./membership-events";

// An App Attest key not used for this long is deleted. The app then gets 403 attestation_failed once, forgets the
// key and registers a new one (ios AppAttestor.reset), so this costs nothing and keeps no stale device keys.
export const APP_ATTEST_KEY_RETENTION_DAYS = 180;

export async function purgeExpired(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const eventCutoff = new Date(Date.now() - SENT_RETENTION_DAYS * 86_400_000).toISOString();
  const keyCutoff = new Date(Date.now() - APP_ATTEST_KEY_RETENTION_DAYS * 86_400_000).toISOString();
  const deviceCutoff = new Date(Date.now() - DEVICE_INACTIVE_DAYS * 86_400_000).toISOString();
  const [sessions, nonces, flows, challenges, keys, devices, , invitations, pairings, kidSessions, events] =
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
      env.DB.prepare("DELETE FROM sign_in_nonces WHERE expires_at <= ?").bind(now),
      // A flow lives 10 minutes; a code issued near its end lives at most 2 more.
      env.DB.prepare(
        "DELETE FROM apple_web_flows WHERE expires_at <= ? AND (code_expires_at IS NULL OR code_expires_at <= ?)",
      ).bind(now, now),
      env.DB.prepare("DELETE FROM app_attest_challenges WHERE expires_at <= ?").bind(now),
      env.DB.prepare("DELETE FROM app_attest_keys WHERE coalesce(last_used_at, created_at) <= ?").bind(keyCutoff),
      // Devices without a request for 90 days go, with their prekeys (cascade); their sessions are unbound.
      env.DB.prepare("DELETE FROM devices WHERE last_seen_at <= ?").bind(deviceCutoff),
      env.DB.prepare(
        `UPDATE sessions SET device_id = NULL WHERE device_id IS NOT NULL AND NOT EXISTS
         (SELECT 1 FROM devices d WHERE d.account_id = sessions.parent_id AND d.device_id = sessions.device_id)`,
      ),
      env.DB.prepare("DELETE FROM family_invitations WHERE expires_at <= ?").bind(now),
      env.DB.prepare("DELETE FROM kid_pairings WHERE expires_at <= ?").bind(now),
      env.DB.prepare("DELETE FROM kid_sessions WHERE expires_at <= ?").bind(now),
      // Membership events only once sent (unsent ones wait for the queue), and kept 7 days for debugging.
      env.DB.prepare("DELETE FROM membership_outbox WHERE sent_at IS NOT NULL AND sent_at <= ?").bind(eventCutoff),
    ]);
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
      membershipEvents: events?.meta.changes ?? 0,
    }),
  );
}
