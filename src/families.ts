// Families: parents and the kids they add. A parent belongs to one family (v1). The app calls POST /v1/families
// right after sign-in (idempotent), so a family exists from the first sign-in on; a second parent joins with a
// one-time invitation code instead. Only members see a family; for everyone else it doesn't exist (404).
import { authenticateAccount } from "./accounts";
import { invalid, onlyFields, readJson } from "./body";
import { randomBase64Url, sha256Hex } from "./crypto";
import type { Env } from "./env";
import { empty, error, json } from "./http";
import { handleListKidSessions, handleRevokeKidSession } from "./kid-sessions";
import { deviceRemovedEvents, flushMembershipEvents, membershipEvent, sessionsRevokedEvent } from "./membership-events";
import { handleCreatePairing, handleUnpair, kidInParentsFamily, revokeKidPhones } from "./pairing";
import { authenticate, type Session } from "./sessions";

export const INVITATION_TTL_SECONDS = 72 * 3600;
export const MAX_OPEN_INVITATIONS = 5;
export const MAX_KIDS = 12;
const INVITATION_PATTERN = /^zki_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AVATAR_PATTERN = /^[a-z0-9-]{1,32}$/;
// Control characters, and line/paragraph separators: names are shown on one line.
const CONTROL = /[\p{Cc}\u2028\u2029]/u;

export interface Kid {
  id: string;
  nickname: string;
  avatar: string;
  grade: number | null;
  createdAt: string;
}

export interface Family {
  id: string;
  name: string | null;
  createdAt: string;
  parents: { id: string; displayName: string | null }[];
  kids: Kid[];
}

const unauthorized = () =>
  error(401, "unauthorized", "Sign in first: send Authorization: Bearer <session token>.", {
    "www-authenticate": "Bearer",
  });
const notFound = () => error(404, "not_found", "No such family.");

// All /v1/families paths. Null when the path isn't one of them.
export async function routeFamilies(request: Request, env: Env, path: string): Promise<Response | null> {
  let match: RegExpExecArray | null;
  if (path === "/v1/families") {
    if (request.method === "GET") return handleListFamilies(request, env);
    if (request.method === "POST") return handleCreateFamily(request, env);
    return error(405, "method_not_allowed", "Use GET or POST.", { allow: "GET, POST" });
  }
  if (path === "/v1/families/join") {
    return request.method === "POST" ? handleJoinFamily(request, env) : methodNotAllowed();
  }
  if ((match = /^\/v1\/families\/([^/]+)\/parents\/invitations$/.exec(path))) {
    return request.method === "POST" ? handleInvite(request, env, match[1] ?? "") : methodNotAllowed();
  }
  if ((match = /^\/v1\/families\/([^/]+)\/parents\/([^/]+)$/.exec(path))) {
    return request.method === "DELETE"
      ? handleRemoveParent(request, env, match[1] ?? "", match[2] ?? "")
      : error(405, "method_not_allowed", "Use DELETE.", { allow: "DELETE" });
  }
  if ((match = /^\/v1\/families\/([^/]+)\/kids\/([^/]+)\/pairing$/.exec(path))) {
    const [, familyId = "", kidId = ""] = match;
    if (request.method === "POST") return handleCreatePairing(request, env, familyId, kidId);
    if (request.method === "DELETE") return handleUnpair(request, env, familyId, kidId);
    return error(405, "method_not_allowed", "Use POST or DELETE.", { allow: "POST, DELETE" });
  }
  if ((match = /^\/v1\/families\/([^/]+)\/kids\/([^/]+)$/.exec(path))) {
    const [, familyId = "", kidId = ""] = match;
    if (request.method === "PATCH") return handleUpdateKid(request, env, familyId, kidId);
    if (request.method === "DELETE") return handleRemoveKid(request, env, familyId, kidId);
    return error(405, "method_not_allowed", "Use PATCH or DELETE.", { allow: "PATCH, DELETE" });
  }
  if ((match = /^\/v1\/families\/([^/]+)\/kids\/([^/]+)\/sessions$/.exec(path))) {
    return request.method === "GET"
      ? handleListKidSessions(request, env, match[1] ?? "", match[2] ?? "")
      : error(405, "method_not_allowed", "Use GET.", { allow: "GET" });
  }
  if ((match = /^\/v1\/families\/([^/]+)\/kids\/([^/]+)\/sessions\/([^/]+)$/.exec(path))) {
    return request.method === "DELETE"
      ? handleRevokeKidSession(request, env, match[1] ?? "", match[2] ?? "", match[3] ?? "")
      : error(405, "method_not_allowed", "Use DELETE.", { allow: "DELETE" });
  }
  if ((match = /^\/v1\/families\/([^/]+)\/kids$/.exec(path))) {
    return request.method === "POST" ? handleAddKid(request, env, match[1] ?? "") : methodNotAllowed();
  }
  return null;
}

const methodNotAllowed = () => error(405, "method_not_allowed", "Use POST.", { allow: "POST" });

// A trimmed one-line text of 1..max characters, or an invalid_request.
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw invalid(`${field} must be a string.`);
  const trimmed = value.trim();
  // Code points, as SQLite's length() and JSON Schema's maxLength count them.
  const length = Array.from(trimmed).length;
  if (length < 1 || length > max || CONTROL.test(trimmed)) {
    throw invalid(`${field} must be 1-${max} characters on one line.`);
  }
  return trimmed;
}

function avatarId(value: unknown): string {
  if (typeof value !== "string" || !AVATAR_PATTERN.test(value)) {
    throw invalid("avatar must be an avatar id: 1-32 lowercase letters, digits or dashes.");
  }
  return value;
}

// An optional JSON body: none at all is the same as {}.
async function optionalJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.body || request.headers.get("content-length") === "0") return {};
  return readJson(request);
}

export async function familyIdOf(env: Env, parentId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT family_id FROM family_parents WHERE parent_id = ?")
    .bind(parentId)
    .first<{ family_id: string }>();
  return row?.family_id ?? null;
}

export async function loadFamily(env: Env, familyId: string): Promise<Family | null> {
  const [families, parents, kids] = await env.DB.batch([
    env.DB.prepare("SELECT id, name, created_at FROM families WHERE id = ?").bind(familyId),
    env.DB.prepare(
      `SELECT p.id, p.display_name FROM family_parents fp JOIN parents p ON p.id = fp.parent_id
       WHERE fp.family_id = ? ORDER BY fp.joined_at, p.id`,
    ).bind(familyId),
    env.DB.prepare(
      "SELECT id, nickname, avatar, grade, created_at FROM kids WHERE family_id = ? ORDER BY created_at, id",
    ).bind(familyId),
  ]);
  const family = families?.results[0] as { id: string; name: string | null; created_at: string } | undefined;
  if (!family) return null;
  return {
    id: family.id,
    name: family.name,
    createdAt: family.created_at,
    parents: ((parents?.results ?? []) as { id: string; display_name: string | null }[]).map((p) => ({
      id: p.id,
      displayName: p.display_name,
    })),
    kids: ((kids?.results ?? []) as KidRow[]).map(toKid),
  };
}

interface KidRow {
  id: string;
  nickname: string;
  avatar: string;
  grade: number | null;
  created_at: string;
}

export async function loadKid(env: Env, kidId: string): Promise<Kid | null> {
  const row = await env.DB.prepare("SELECT id, nickname, avatar, grade, created_at FROM kids WHERE id = ?")
    .bind(kidId)
    .first<KidRow>();
  return row ? toKid(row) : null;
}

function toKid(row: KidRow): Kid {
  return { id: row.id, nickname: row.nickname, avatar: row.avatar, grade: row.grade, createdAt: row.created_at };
}

// The family when this parent is a member of it, else null (the caller answers 404).
async function memberFamily(env: Env, parentId: string, familyId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT family_id FROM family_parents WHERE family_id = ? AND parent_id = ?")
    .bind(familyId, parentId)
    .first<{ family_id: string }>();
  return row?.family_id ?? null;
}

// Parents and kids: a kid sees their own family.
async function handleListFamilies(request: Request, env: Env): Promise<Response> {
  const account = await authenticateAccount(request, env);
  if (!account) return unauthorized();
  const familyId = account.role === "kid" ? account.familyId : await familyIdOf(env, account.id);
  const family = familyId ? await loadFamily(env, familyId) : null;
  return json({ families: family ? [family] : [] });
}

async function handleCreateFamily(request: Request, env: Env): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  const body = await optionalJson(request);
  onlyFields(body, ["name"], "the body");
  const name = body.name === undefined || body.name === null ? null : text(body.name, "name", 60);

  const existing = await familyIdOf(env, session.parentId);
  if (existing) return json(await loadFamily(env, existing), 200);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO families (id, name, created_at) VALUES (?, ?, ?)").bind(id, name, now),
      env.DB.prepare("INSERT INTO family_parents (family_id, parent_id, joined_at) VALUES (?, ?, ?)").bind(
        id,
        session.parentId,
        now,
      ),
      membershipEvent(env, { type: "family.member_added", familyId: id, accountId: session.parentId, role: "parent" }),
    ]);
  } catch (e) {
    // Two creates at once: the other one won (unique parent_id). The batch rolled back; return that family.
    if (!/UNIQUE/i.test(String(e))) throw e;
    const winner = await familyIdOf(env, session.parentId);
    if (!winner) throw e;
    return json(await loadFamily(env, winner), 200);
  }
  await flushMembershipEvents(env);
  return json(await loadFamily(env, id), 201);
}

async function handleInvite(request: Request, env: Env, familyId: string): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  if (!(await memberFamily(env, session.parentId, familyId))) return notFound();
  // { replaces }: the code replaces the phone of that parent of the family (it's joined by that parent only).
  const body = await optionalJson(request);
  onlyFields(body, ["replaces"], "the body");
  let replaces: string | null = null;
  if (body.replaces !== undefined && body.replaces !== null) {
    if (typeof body.replaces !== "string" || !UUID.test(body.replaces)) throw invalid("replaces must be a parent id.");
    if (!(await memberFamily(env, body.replaces, familyId))) return notFound();
    replaces = body.replaces;
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const open = await env.DB.prepare(
    "SELECT count(*) AS n FROM family_invitations WHERE family_id = ? AND used_at IS NULL AND expires_at > ?",
  )
    .bind(familyId, nowIso)
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_INVITATIONS) {
    return error(429, "too_many_invitations", `At most ${MAX_OPEN_INVITATIONS} open invitations per family.`);
  }

  const code = `zki_${randomBase64Url(32)}`;
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO family_invitations (code_hash, family_id, created_by, created_at, expires_at, replaces_account_id) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(await sha256Hex(code), familyId, session.parentId, nowIso, expiresAt, replaces)
    .run();
  return json({ code, expiresAt }, 201);
}

async function handleJoinFamily(request: Request, env: Env): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  const body = await readJson(request);
  onlyFields(body, ["code"], "the body");
  if (typeof body.code !== "string" || !INVITATION_PATTERN.test(body.code)) {
    throw invalid("code is required: the invitation code (zki_...).");
  }
  const codeHash = await sha256Hex(body.code);
  const nowIso = new Date().toISOString();
  const gone = () => error(410, "invitation_invalid", "This invitation is unknown, expired or already used.");

  const invitation = await env.DB.prepare(
    "SELECT family_id, replaces_account_id FROM family_invitations WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
  )
    .bind(codeHash, nowIso)
    .first<{ family_id: string; replaces_account_id: string | null }>();
  if (!invitation) {
    // Already a member through this (used) code: answer as for a repeat, so a retried join doesn't fail.
    const used = await env.DB.prepare("SELECT family_id FROM family_invitations WHERE code_hash = ? AND used_by = ?")
      .bind(codeHash, session.parentId)
      .first<{ family_id: string }>();
    return used ? json(await loadFamily(env, used.family_id)) : gone();
  }

  if (invitation.replaces_account_id) {
    if (invitation.replaces_account_id !== session.parentId) {
      return error(403, "invitation_for_other_account", "This code is for another parent's new phone.");
    }
    return replacePhone(env, session, invitation.family_id, codeHash, nowIso);
  }

  const current = await familyIdOf(env, session.parentId);
  if (current === invitation.family_id) return json(await loadFamily(env, current));
  if (current) {
    const others = await env.DB.prepare(
      `SELECT (SELECT count(*) FROM family_parents WHERE family_id = ?1 AND parent_id != ?2)
            + (SELECT count(*) FROM kids WHERE family_id = ?1) AS n`,
    )
      .bind(current, session.parentId)
      .first<{ n: number }>();
    if ((others?.n ?? 0) > 0) {
      return error(409, "already_in_family", "You already belong to a family with kids or another parent.");
    }
  }

  // One transaction: use up the code (only if still open), leave the empty family, join. The last two only run
  // when this request is the one that used the code (its own claim id, unique per request).
  const { claim: claimCode, onlyIfUsedByMe } = claimInvitation(env, session, codeHash, nowIso);
  const usedByMe = onlyIfUsedByMe.sql;
  const [claim] = await env.DB.batch([
    claimCode,
    env.DB.prepare(`DELETE FROM families WHERE id = ? AND ${usedByMe}`).bind(current ?? "", ...onlyIfUsedByMe.binds),
    env.DB.prepare(
      `INSERT INTO family_parents (family_id, parent_id, joined_at) SELECT ?, ?, ? WHERE ${usedByMe}`,
    ).bind(invitation.family_id, session.parentId, nowIso, ...onlyIfUsedByMe.binds),
    ...(current
      ? [
          membershipEvent(
            env,
            { type: "family.member_removed", familyId: current, accountId: session.parentId },
            onlyIfUsedByMe,
          ),
        ]
      : []),
    membershipEvent(
      env,
      { type: "family.member_added", familyId: invitation.family_id, accountId: session.parentId, role: "parent" },
      onlyIfUsedByMe,
    ),
  ]);
  if ((claim?.meta.changes ?? 0) !== 1) return gone();
  await flushMembershipEvents(env);
  return json(await loadFamily(env, invitation.family_id));
}

// The statement that uses up an open invitation code for this request, and the SQL condition (with its binds) that
// holds only when this request's claim is the one that used it: a random claim id per request, so two redemptions in
// the same millisecond by the same parent can't both match.
function claimInvitation(
  env: Env,
  session: Session,
  codeHash: string,
  nowIso: string,
): { claim: D1PreparedStatement; onlyIfUsedByMe: { sql: string; binds: unknown[] } } {
  const claimId = crypto.randomUUID();
  return {
    claim: env.DB.prepare(
      `UPDATE family_invitations SET used_at = ?, used_by = ?, claim_id = ?
       WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
    ).bind(nowIso, session.parentId, claimId, codeHash, nowIso),
    onlyIfUsedByMe: {
      sql: "EXISTS (SELECT 1 FROM family_invitations WHERE code_hash = ? AND claim_id = ?)",
      binds: [codeHash, claimId],
    },
  };
}

// A replacement code, redeemed by the parent it replaces on the new phone: the other sessions and devices of the
// parent go (device.removed for each), the current session stays. One transaction; the code is used up only here.
async function replacePhone(
  env: Env,
  session: Session,
  familyId: string,
  codeHash: string,
  nowIso: string,
): Promise<Response> {
  const { claim: claimCode, onlyIfUsedByMe } = claimInvitation(env, session, codeHash, nowIso);
  const usedByMe = onlyIfUsedByMe.sql;
  const claimed = onlyIfUsedByMe.binds;
  const [claim] = await env.DB.batch([
    claimCode,
    deviceRemovedEvents(env, `account_id = ? AND (device_id IS NOT ?) AND ${usedByMe}`, [
      session.parentId,
      session.deviceId,
      ...claimed,
    ]),
    env.DB.prepare(`DELETE FROM devices WHERE account_id = ? AND (device_id IS NOT ?) AND ${usedByMe}`).bind(
      session.parentId,
      session.deviceId,
      ...claimed,
    ),
    env.DB.prepare(`DELETE FROM sessions WHERE parent_id = ? AND token_hash != ? AND ${usedByMe}`).bind(
      session.parentId,
      session.tokenHash,
      ...claimed,
    ),
  ]);
  if ((claim?.meta.changes ?? 0) !== 1) {
    return error(410, "invitation_invalid", "This invitation is unknown, expired or already used.");
  }
  await flushMembershipEvents(env);
  return json(await loadFamily(env, familyId));
}

// DELETE /v1/families/{familyId}/parents/{accountId}: a parent removes another parent (not themselves, and never the
// last parent). The removed parent's sessions and devices go; their chat tokens stop (sessions_revoked, device.removed);
// family.member_removed lets the chat service take them out of the family's conversations.
async function handleRemoveParent(request: Request, env: Env, familyId: string, accountId: string): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  if (!(await memberFamily(env, session.parentId, familyId))) return notFound();
  if (accountId === session.parentId) {
    return error(409, "cannot_remove_self", "You can't remove yourself from the family.");
  }
  if (!(await memberFamily(env, accountId, familyId))) return notFound();

  // Every statement is guarded by the same condition: the target is a member and another parent stays. The membership
  // row is deleted last, so the guards hold for the statements before it.
  const guard = `EXISTS (SELECT 1 FROM family_parents WHERE family_id = ? AND parent_id = ?)
    AND (SELECT count(*) FROM family_parents WHERE family_id = ?) > 1`;
  const guarded = [familyId, accountId, familyId];
  const results = await env.DB.batch([
    deviceRemovedEvents(env, `account_id = ? AND ${guard}`, [accountId, ...guarded]),
    env.DB.prepare(`DELETE FROM devices WHERE account_id = ? AND ${guard}`).bind(accountId, ...guarded),
    env.DB.prepare(`DELETE FROM sessions WHERE parent_id = ? AND ${guard}`).bind(accountId, ...guarded),
    env.DB.prepare(`UPDATE parents SET session_epoch = session_epoch + 1 WHERE id = ? AND ${guard}`).bind(
      accountId,
      ...guarded,
    ),
    sessionsRevokedEvent(env, accountId, { sql: guard, binds: guarded }),
    membershipEvent(env, { type: "family.member_removed", familyId, accountId }, { sql: guard, binds: guarded }),
    env.DB.prepare(
      `DELETE FROM family_parents WHERE family_id = ? AND parent_id = ? AND ${guard} RETURNING parent_id`,
    ).bind(familyId, accountId, ...guarded),
  ]);
  // RETURNING: the row is gone (not a race with another removal), so the guard held.
  if (!results.at(-1)?.results.length) return error(409, "last_parent", "A family keeps at least one parent.");
  await flushMembershipEvents(env);
  return empty(204);
}

async function handleAddKid(request: Request, env: Env, familyId: string): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  if (!(await memberFamily(env, session.parentId, familyId))) return notFound();
  const body = await readJson(request);
  onlyFields(body, ["nickname", "avatar", "grade"], "the body");
  const nickname = text(body.nickname, "nickname", 40);
  const avatar = avatarId(body.avatar);
  let grade: number | null = null;
  if (body.grade !== undefined && body.grade !== null) {
    if (typeof body.grade !== "number" || !Number.isInteger(body.grade) || body.grade < -1 || body.grade > 12) {
      throw invalid("grade must be an integer from -1 (kindergarten) to 12, or null.");
    }
    grade = body.grade;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // Inserted only while the family has fewer than MAX_KIDS (checked in the same statement).
  const [result] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO kids (id, family_id, nickname, avatar, grade, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM kids WHERE family_id = ?) < ?`,
    ).bind(id, familyId, nickname, avatar, grade, now, now, familyId, MAX_KIDS),
    membershipEvent(
      env,
      { type: "family.member_added", familyId, accountId: id, role: "kid" },
      { sql: "EXISTS (SELECT 1 FROM kids WHERE id = ?)", binds: [id] },
    ),
  ]);
  if (result?.meta.changes !== 1) return error(409, "too_many_kids", `A family has at most ${MAX_KIDS} kids.`);
  await flushMembershipEvents(env);
  return json({ id, nickname, avatar, grade, createdAt: now } satisfies Kid, 201);
}

// DELETE /v1/families/{familyId}/kids/{kidId}: the kid account goes, with its phones (sessions, devices, keys,
// identity), pairing codes and shares. Any parent of the family. Events: device.removed per device,
// family.member_removed and account.deleted.
async function handleRemoveKid(request: Request, env: Env, familyId: string, kidId: string): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  if (!(await kidInParentsFamily(env, session.parentId, familyId, kidId))) {
    return error(404, "not_found", "No such kid.");
  }
  const exists = { sql: "EXISTS (SELECT 1 FROM kids WHERE id = ? AND family_id = ?)", binds: [kidId, familyId] };
  const results = await env.DB.batch([
    ...revokeKidPhones(env, kidId),
    membershipEvent(env, { type: "family.member_removed", familyId, accountId: kidId }, exists),
    membershipEvent(env, { type: "account.deleted", accountId: kidId }, exists),
    // Identity and key history go with the kid row (trigger kids_delete_keys); sessions, codes, shares cascade.
    env.DB.prepare("DELETE FROM kids WHERE id = ? AND family_id = ? RETURNING id").bind(kidId, familyId),
  ]);
  // RETURNING, not meta.changes: D1 counts the cascaded rows too.
  if (!results.at(-1)?.results.length) return error(404, "not_found", "No such kid.");
  await flushMembershipEvents(env);
  return empty(204);
}

// PATCH /v1/families/{familyId}/kids/{kidId}: rename the kid or change its avatar (at least one of them). Any parent
// of the family. No membership event: the chat service doesn't know names or avatars.
async function handleUpdateKid(request: Request, env: Env, familyId: string, kidId: string): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  if (!(await kidInParentsFamily(env, session.parentId, familyId, kidId))) {
    return error(404, "not_found", "No such kid.");
  }
  const body = await readJson(request);
  onlyFields(body, ["nickname", "avatar"], "the body");
  if (body.nickname === undefined && body.avatar === undefined) throw invalid("Send nickname, avatar or both.");
  const nickname = body.nickname === undefined ? null : text(body.nickname, "nickname", 40);
  const avatar = body.avatar === undefined ? null : avatarId(body.avatar);
  await env.DB.prepare(
    "UPDATE kids SET nickname = COALESCE(?, nickname), avatar = COALESCE(?, avatar), updated_at = ? WHERE id = ? AND family_id = ?",
  )
    .bind(nickname, avatar, new Date().toISOString(), kidId, familyId)
    .run();
  const kid = await loadKid(env, kidId);
  return kid ? json(kid) : error(404, "not_found", "No such kid.");
}
