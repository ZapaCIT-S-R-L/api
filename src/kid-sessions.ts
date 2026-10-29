// Kid sessions after pairing (api #78): the kid's phone signs itself out (POST /v1/kid/logout), and a parent lists a
// kid's paired phones (one live session each) and revokes a lost or replaced one. A revoked token answers 401
// everywhere at once. The server keeps only the token's SHA-256; sessions are named by a random id.
import { authenticateKid } from "./accounts";
import type { Env } from "./env";
import { empty, error, json } from "./http";
import { deviceRemovedEvents, flushMembershipEvents } from "./membership-events";
import { kidInParentsFamily } from "./pairing";
import { authenticate } from "./sessions";

const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/;

const unauthorized = () =>
  error(401, "unauthorized", "Sign in first: send Authorization: Bearer <session token>.", {
    "www-authenticate": "Bearer",
  });
const noSuchKid = () => error(404, "not_found", "No such kid.");

export interface KidSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

// The kid's phone signs itself out: only this session goes; the kid's other phones stay paired. Parents get 401
// (they use POST /v1/auth/logout). Like a parent's revoke, the device registered on the session goes in the same
// transaction (a device.removed event, prekeys cascade, api #92): the family stops sealing to it, and the chat and
// calls services refuse the phone's chat tokens once the event arrives.
export async function handleKidLogout(request: Request, env: Env): Promise<Response> {
  const kid = await authenticateKid(request, env);
  if (!kid) return unauthorized();
  const boundDevice = "account_id = ? AND device_id = (SELECT device_id FROM kid_sessions WHERE token_hash = ?)";
  await env.DB.batch([
    deviceRemovedEvents(env, boundDevice, [kid.id, kid.tokenHash]),
    env.DB.prepare(`DELETE FROM devices WHERE ${boundDevice}`).bind(kid.id, kid.tokenHash),
    env.DB.prepare("DELETE FROM kid_sessions WHERE token_hash = ?").bind(kid.tokenHash),
  ]);
  await flushMembershipEvents(env);
  return empty(204);
}

export async function handleListKidSessions(
  request: Request,
  env: Env,
  familyId: string,
  kidId: string,
): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  if (!(await kidInParentsFamily(env, session.parentId, familyId, kidId))) return noSuchKid();
  const now = new Date().toISOString();
  const [, , rows] = await env.DB.batch<{ id: string; created_at: string; expires_at: string; last_seen_at: string }>([
    // Rows written by the Worker version before migration 0014 have no id yet: name them now, once.
    env.DB.prepare("UPDATE kid_sessions SET id = lower(hex(randomblob(16))) WHERE kid_id = ? AND id IS NULL").bind(
      kidId,
    ),
    env.DB.prepare("DELETE FROM kid_sessions WHERE kid_id = ? AND expires_at <= ?").bind(kidId, now),
    env.DB.prepare(
      `SELECT id, created_at, expires_at, coalesce(last_seen_at, created_at) AS last_seen_at FROM kid_sessions
       WHERE kid_id = ? ORDER BY created_at, rowid`,
    ).bind(kidId),
  ]);
  const sessions: KidSession[] = (rows?.results ?? []).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastSeenAt: r.last_seen_at,
  }));
  return json({ sessions });
}

// Unpair one phone: the session and its registered device are gone at once, so its token answers 401 from the next
// request on. The kid, the kid's other phones and open pairing codes stay.
export async function handleRevokeKidSession(
  request: Request,
  env: Env,
  familyId: string,
  kidId: string,
  sessionId: string,
): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  if (!(await kidInParentsFamily(env, session.parentId, familyId, kidId))) return noSuchKid();
  const notFound = () => error(404, "not_found", "No such session for this kid.");
  if (!SESSION_ID_PATTERN.test(sessionId)) return notFound();
  // One transaction, as DELETE .../pairing does for every phone: the device registered on the session goes too (a
  // device.removed event, prekeys cascade), so other phones stop sealing messages to the lost one.
  const boundDevice = "account_id = ? AND device_id = (SELECT device_id FROM kid_sessions WHERE id = ? AND kid_id = ?)";
  const results = await env.DB.batch([
    deviceRemovedEvents(env, boundDevice, [kidId, sessionId, kidId]),
    env.DB.prepare(`DELETE FROM devices WHERE ${boundDevice}`).bind(kidId, sessionId, kidId),
    env.DB.prepare("DELETE FROM kid_sessions WHERE id = ? AND kid_id = ?").bind(sessionId, kidId),
  ]);
  if (results[2]?.meta.changes !== 1) return notFound();
  await flushMembershipEvents(env);
  return empty(204);
}
