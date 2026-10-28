// Connections between families, minimal (api #44): a parent shows a one-time code (QR or link), a parent of another
// family accepts it, and the two families are connected. Then each family shares chosen kids, one by one; the other
// family sees a shared kid's nickname and avatar only. Any parent of either family can unshare their own kids or
// remove the connection. Parents only: kids get 401. Search, email invites and blocks come later.
import { invalid, onlyFields, readJson } from "./body";
import { randomBase64Url, sha256Hex } from "./crypto";
import type { Env } from "./env";
import { familyIdOf } from "./families";
import { empty, error, json } from "./http";
import { flushMembershipEvents, membershipEvent } from "./membership-events";
import { authenticate } from "./sessions";

export const CONNECTION_INVITATION_TTL_SECONDS = 72 * 3600;
export const MAX_OPEN_CONNECTION_INVITATIONS = 5;
export const MAX_CONNECTIONS = 50;
const CODE_PATTERN = /^zkc_[A-Za-z0-9_-]{43}$/;

export interface Connection {
  id: string;
  createdAt: string;
  family: { id: string; name: string | null; parents: { id: string; displayName: string | null }[] };
  sharedKids: { mine: string[]; theirs: { id: string; nickname: string; avatar: string }[] };
}

const unauthorized = () =>
  error(401, "unauthorized", "Sign in first: send Authorization: Bearer <session token>.", {
    "www-authenticate": "Bearer",
  });
const notFound = () => error(404, "not_found", "No such connection.");
const noFamily = () => error(409, "no_family", "Create your family first (POST /v1/families).");

// All /v1/connections paths. Null when the path isn't one of them.
export async function routeConnections(request: Request, env: Env, path: string): Promise<Response | null> {
  let match: RegExpExecArray | null;
  const only = (method: string, run: () => Promise<Response>) =>
    request.method === method
      ? run()
      : Promise.resolve(error(405, "method_not_allowed", `Use ${method}.`, { allow: method }));
  if (path === "/v1/connections") return only("GET", () => handleList(request, env));
  if (path === "/v1/connections/invitations") return only("POST", () => handleInvite(request, env));
  if (path === "/v1/connections/accept") return only("POST", () => handleAccept(request, env));
  if ((match = /^\/v1\/connections\/([^/]+)\/shared-kids\/([^/]+)$/.exec(path))) {
    const [, connectionId = "", kidId = ""] = match;
    if (request.method === "PUT") return handleShare(request, env, connectionId, kidId, true);
    if (request.method === "DELETE") return handleShare(request, env, connectionId, kidId, false);
    return error(405, "method_not_allowed", "Use PUT or DELETE.", { allow: "PUT, DELETE" });
  }
  if ((match = /^\/v1\/connections\/([^/]+)$/.exec(path))) {
    const connectionId = match[1] ?? "";
    return only("DELETE", () => handleRemove(request, env, connectionId));
  }
  return null;
}

// The signed-in parent and their family, or the response to send instead.
async function parentWithFamily(
  request: Request,
  env: Env,
): Promise<Response | { parentId: string; familyId: string }> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  const familyId = await familyIdOf(env, session.parentId);
  return familyId ? { parentId: session.parentId, familyId } : noFamily();
}

// The connection's other family, when `familyId` is in it; else null.
async function otherFamily(env: Env, connectionId: string, familyId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT CASE WHEN family_a = ?2 THEN family_b ELSE family_a END AS other FROM family_connections
     WHERE id = ?1 AND (family_a = ?2 OR family_b = ?2)`,
  )
    .bind(connectionId, familyId)
    .first<{ other: string }>();
  return row?.other ?? null;
}

async function loadConnections(env: Env, familyId: string): Promise<Connection[]> {
  const { results: rows } = await env.DB.prepare(
    `SELECT c.id, c.created_at, f.id AS other_id, f.name AS other_name FROM family_connections c
     JOIN families f ON f.id = CASE WHEN c.family_a = ?1 THEN c.family_b ELSE c.family_a END
     WHERE c.family_a = ?1 OR c.family_b = ?1 ORDER BY c.created_at, c.id`,
  )
    .bind(familyId)
    .all<{ id: string; created_at: string; other_id: string; other_name: string | null }>();
  const connections: Connection[] = [];
  for (const row of rows) {
    const [parents, shared] = await env.DB.batch([
      env.DB.prepare(
        `SELECT p.id, p.display_name FROM family_parents fp JOIN parents p ON p.id = fp.parent_id
         WHERE fp.family_id = ? ORDER BY fp.joined_at, p.id`,
      ).bind(row.other_id),
      env.DB.prepare(
        `SELECT k.id, k.nickname, k.avatar, k.family_id FROM connection_shared_kids s JOIN kids k ON k.id = s.kid_id
         WHERE s.connection_id = ? ORDER BY s.shared_at, k.id`,
      ).bind(row.id),
    ]);
    const kids = (shared?.results ?? []) as { id: string; nickname: string; avatar: string; family_id: string }[];
    connections.push({
      id: row.id,
      createdAt: row.created_at,
      family: {
        id: row.other_id,
        name: row.other_name,
        parents: ((parents?.results ?? []) as { id: string; display_name: string | null }[]).map((p) => ({
          id: p.id,
          displayName: p.display_name,
        })),
      },
      sharedKids: {
        mine: kids.filter((k) => k.family_id === familyId).map((k) => k.id),
        theirs: kids
          .filter((k) => k.family_id !== familyId)
          .map((k) => ({ id: k.id, nickname: k.nickname, avatar: k.avatar })),
      },
    });
  }
  return connections;
}

async function handleList(request: Request, env: Env): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  const familyId = await familyIdOf(env, session.parentId);
  return json({ connections: familyId ? await loadConnections(env, familyId) : [] });
}

async function handleInvite(request: Request, env: Env): Promise<Response> {
  const caller = await parentWithFamily(request, env);
  if (caller instanceof Response) return caller;
  const now = new Date();
  const nowIso = now.toISOString();
  const open = await env.DB.prepare(
    "SELECT count(*) AS n FROM connection_invitations WHERE family_id = ? AND used_at IS NULL AND expires_at > ?",
  )
    .bind(caller.familyId, nowIso)
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_CONNECTION_INVITATIONS) {
    return error(
      429,
      "too_many_invitations",
      `At most ${MAX_OPEN_CONNECTION_INVITATIONS} open connection invitations per family.`,
    );
  }
  const code = `zkc_${randomBase64Url(32)}`;
  const expiresAt = new Date(now.getTime() + CONNECTION_INVITATION_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO connection_invitations (code_hash, family_id, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(await sha256Hex(code), caller.familyId, caller.parentId, nowIso, expiresAt)
    .run();
  return json({ code, expiresAt }, 201);
}

async function handleAccept(request: Request, env: Env): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  const body = await readJson(request);
  onlyFields(body, ["code"], "the body");
  if (typeof body.code !== "string" || !CODE_PATTERN.test(body.code)) {
    throw invalid("code is required: the connection code (zkc_...).");
  }
  const familyId = await familyIdOf(env, session.parentId);
  if (!familyId) return noFamily();

  const codeHash = await sha256Hex(body.code);
  const nowIso = new Date().toISOString();
  const invitation = await env.DB.prepare(
    "SELECT family_id FROM connection_invitations WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
  )
    .bind(codeHash, nowIso)
    .first<{ family_id: string }>();
  if (!invitation) {
    return error(410, "invitation_invalid", "This connection code is unknown, expired or already used.");
  }
  if (invitation.family_id === familyId) {
    return error(409, "own_family", "This code is from your own family. Show it to the other family.");
  }
  const [a, b] = [familyId, invitation.family_id].sort() as [string, string];
  const existing = await env.DB.prepare("SELECT id FROM family_connections WHERE family_a = ? AND family_b = ?")
    .bind(a, b)
    .first<{ id: string }>();
  if (existing) return error(409, "already_connected", "Your families are already connected.");
  // The cap is per family: each of the two counts its own connections, not the pair's combined neighbourhoods.
  const tooMany = () => error(409, "too_many_connections", `A family has at most ${MAX_CONNECTIONS} connections.`);
  if (await atConnectionCap(env, a, b)) return tooMany();

  // One transaction: use up the code (only if still open and both families are still under the cap), then
  // connect only for this request. The cap is re-checked inside the same statement, so concurrent accepts
  // can't take a family past it.
  const id = crypto.randomUUID();
  const onlyIf = {
    sql: "EXISTS (SELECT 1 FROM connection_invitations WHERE code_hash = ? AND used_by = ? AND used_at = ?)",
    binds: [codeHash, session.parentId, nowIso],
  };
  let claim: D1Result | undefined;
  try {
    [claim] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE connection_invitations SET used_at = ?, used_by = ?
         WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
           AND ${CONNECTIONS_OF} < ${MAX_CONNECTIONS} AND ${CONNECTIONS_OF} < ${MAX_CONNECTIONS}`,
      ).bind(nowIso, session.parentId, codeHash, nowIso, a, a, b, b),
      env.DB.prepare(
        `INSERT INTO family_connections (id, family_a, family_b, created_by, created_at)
         SELECT ?, ?, ?, ?, ? WHERE ${onlyIf.sql}`,
      ).bind(id, a, b, session.parentId, nowIso, ...onlyIf.binds),
      membershipEvent(env, { type: "connection.created", connectionId: id, familyIds: [a, b] }, onlyIf),
    ]);
  } catch (e) {
    // Accepted twice at once: the other one connected the families (unique pair). Nothing was changed here.
    if (/UNIQUE/i.test(String(e))) return error(409, "already_connected", "Your families are already connected.");
    throw e;
  }
  if ((claim?.meta.changes ?? 0) !== 1) {
    // Not claimed: either the code was used up meanwhile, or a family reached the cap meanwhile (code stays open).
    if (await atConnectionCap(env, a, b)) return tooMany();
    return error(410, "invitation_invalid", "This connection code is unknown, expired or already used.");
  }
  await flushMembershipEvents(env);
  const connection = (await loadConnections(env, familyId)).find((c) => c.id === id);
  return json(connection, 201);
}

// How many connections one family has (bind the family id twice).
const CONNECTIONS_OF = "(SELECT count(*) FROM family_connections WHERE family_a = ? OR family_b = ?)";

// True when either family already has MAX_CONNECTIONS connections.
async function atConnectionCap(env: Env, a: string, b: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT ${CONNECTIONS_OF} AS na, ${CONNECTIONS_OF} AS nb`)
    .bind(a, a, b, b)
    .first<{ na: number; nb: number }>();
  return (row?.na ?? 0) >= MAX_CONNECTIONS || (row?.nb ?? 0) >= MAX_CONNECTIONS;
}

async function handleShare(
  request: Request,
  env: Env,
  connectionId: string,
  kidId: string,
  share: boolean,
): Promise<Response> {
  const caller = await parentWithFamily(request, env);
  if (caller instanceof Response) return caller;
  if (!(await otherFamily(env, connectionId, caller.familyId))) return notFound();
  const kid = await env.DB.prepare("SELECT id FROM kids WHERE id = ? AND family_id = ?")
    .bind(kidId, caller.familyId)
    .first<{ id: string }>();
  if (!kid) return error(404, "not_found", "No such kid in your family.");

  const nowIso = new Date().toISOString();
  const shared = "EXISTS (SELECT 1 FROM connection_shared_kids WHERE connection_id = ? AND kid_id = ?)";
  // The event only when something changed: shared now and wasn't before, or the other way round.
  await env.DB.batch(
    share
      ? [
          membershipEvent(
            env,
            { type: "connection.kid_shared", connectionId, kidAccountId: kidId },
            { sql: `NOT ${shared}`, binds: [connectionId, kidId] },
          ),
          env.DB.prepare(
            `INSERT INTO connection_shared_kids (connection_id, kid_id, shared_by, shared_at) VALUES (?, ?, ?, ?)
             ON CONFLICT DO NOTHING`,
          ).bind(connectionId, kidId, caller.parentId, nowIso),
        ]
      : [
          membershipEvent(
            env,
            { type: "connection.kid_unshared", connectionId, kidAccountId: kidId },
            { sql: shared, binds: [connectionId, kidId] },
          ),
          env.DB.prepare("DELETE FROM connection_shared_kids WHERE connection_id = ? AND kid_id = ?").bind(
            connectionId,
            kidId,
          ),
        ],
  );
  await flushMembershipEvents(env);
  return empty(204);
}

async function handleRemove(request: Request, env: Env, connectionId: string): Promise<Response> {
  const caller = await parentWithFamily(request, env);
  if (caller instanceof Response) return caller;
  if (!(await otherFamily(env, connectionId, caller.familyId))) return notFound();
  await env.DB.batch([
    membershipEvent(
      env,
      { type: "connection.removed", connectionId },
      { sql: "EXISTS (SELECT 1 FROM family_connections WHERE id = ?)", binds: [connectionId] },
    ),
    env.DB.prepare("DELETE FROM family_connections WHERE id = ?").bind(connectionId),
  ]);
  await flushMembershipEvents(env);
  return empty(204);
}
