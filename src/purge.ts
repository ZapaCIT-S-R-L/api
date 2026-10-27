// Daily cron (wrangler.jsonc triggers): deletes expired sessions, sign-in nonces, Apple web flows, App Attest
// challenges, family invitations, kid pairing codes and kid sessions, and App Attest keys unused for 180 days. Data minimisation, and it keeps the
// one-time tables small however many are requested.
import type { Env } from "./env";

// An App Attest key not used for this long is deleted. The app then gets 403 attestation_failed once, forgets the
// key and registers a new one (ios AppAttestor.reset), so this costs nothing and keeps no stale device keys.
export const APP_ATTEST_KEY_RETENTION_DAYS = 180;

export async function purgeExpired(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const keyCutoff = new Date(Date.now() - APP_ATTEST_KEY_RETENTION_DAYS * 86_400_000).toISOString();
  const [sessions, nonces, flows, challenges, keys, invitations, pairings, kidSessions] = await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM sign_in_nonces WHERE expires_at <= ?").bind(now),
    // A flow lives 10 minutes; a code issued near its end lives at most 2 more.
    env.DB.prepare(
      "DELETE FROM apple_web_flows WHERE expires_at <= ? AND (code_expires_at IS NULL OR code_expires_at <= ?)",
    ).bind(now, now),
    env.DB.prepare("DELETE FROM app_attest_challenges WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM app_attest_keys WHERE coalesce(last_used_at, created_at) <= ?").bind(keyCutoff),
    env.DB.prepare("DELETE FROM family_invitations WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM kid_pairings WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM kid_sessions WHERE expires_at <= ?").bind(now),
  ]);
  console.log(
    JSON.stringify({
      msg: "purged expired",
      sessions: sessions?.meta.changes ?? 0,
      nonces: nonces?.meta.changes ?? 0,
      appleWebFlows: flows?.meta.changes ?? 0,
      appAttestChallenges: challenges?.meta.changes ?? 0,
      appAttestKeys: keys?.meta.changes ?? 0,
      familyInvitations: invitations?.meta.changes ?? 0,
      kidPairings: pairings?.meta.changes ?? 0,
      kidSessions: kidSessions?.meta.changes ?? 0,
    }),
  );
}
