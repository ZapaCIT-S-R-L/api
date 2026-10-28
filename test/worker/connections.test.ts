// Connections between families, minimal: a parent shows a one-time QR/link code, a parent of another family accepts
// it, then each family shares chosen kids (only nickname and avatar are visible to the other family). Either family
// can unshare a kid or remove the connection. Every change is a membership event for the chat service.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationScopes, membersOf } from "../../src/family-membership";
import {
  call,
  count,
  makeIssuer,
  resetJwksCache,
  signInParent,
  stubJwks,
  type ErrorBody,
  type TestIssuer,
} from "./helpers";

interface Connection {
  id: string;
  createdAt: string;
  family: { id: string; name: string | null; parents: { id: string; displayName: string | null }[] };
  sharedKids: { mine: string[]; theirs: { id: string; nickname: string; avatar: string }[] };
}

let apple: TestIssuer;

beforeEach(async () => {
  resetJwksCache();
  apple = await makeIssuer();
  stubJwks([apple], []);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function send(path: string, auth: Record<string, string>, body?: unknown, method = "POST"): Promise<Response> {
  return call(path, {
    method,
    headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// A parent with a family (named) and one kid.
async function family(sub: string, name: string, kid = "Mia") {
  const parent = await signInParent(apple, sub, sub.toUpperCase());
  const { id } = await (await send("/v1/families", parent.auth, { name })).json<{ id: string }>();
  const kidRes = await send(`/v1/families/${id}/kids`, parent.auth, { nickname: kid, avatar: "robot-4", grade: 2 });
  const { id: kidId } = await kidRes.json<{ id: string }>();
  return { parent, familyId: id, kidId };
}

async function connect(a: Awaited<ReturnType<typeof family>>, b: Awaited<ReturnType<typeof family>>) {
  const inv = await send("/v1/connections/invitations", a.parent.auth);
  expect(inv.status).toBe(201);
  const { code } = await inv.json<{ code: string }>();
  const res = await send("/v1/connections/accept", b.parent.auth, { code });
  expect(res.status).toBe(201);
  return res.json<Connection>();
}

// n connections of one family with as many families that exist only in the database (so no sign-ins or kids).
async function seedConnections(familyId: string, n: number, tag: string): Promise<void> {
  const nowIso = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < n; i++) {
    const other = `${tag}-${String(i).padStart(2, "0")}-${familyId}`;
    const [a, b] = [familyId, other].sort() as [string, string];
    statements.push(
      env.DB.prepare("INSERT INTO families (id, created_at) VALUES (?, ?)").bind(other, nowIso),
      env.DB.prepare("INSERT INTO family_connections (id, family_a, family_b, created_at) VALUES (?, ?, ?, ?)").bind(
        crypto.randomUUID(),
        a,
        b,
        nowIso,
      ),
    );
  }
  await env.DB.batch(statements);
}

async function list(auth: Record<string, string>): Promise<Connection[]> {
  const res = await call("/v1/connections", { headers: auth });
  expect(res.status).toBe(200);
  return (await res.json<{ connections: Connection[] }>()).connections;
}

async function events(): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT body FROM membership_outbox ORDER BY seq").all<{ body: string }>();
  return results
    .map((r) => JSON.parse(r.body) as Record<string, unknown>)
    .filter((e) => String(e.type).startsWith("connection."));
}

async function errorCode(res: Response): Promise<string> {
  return (await res.json<ErrorBody>()).error.code;
}

describe("invitation and accept", () => {
  it("a parent creates a one-time code (72 h, hash only); a parent of another family accepts it", async () => {
    const pop = await family("ana", "Pop");
    const ion = await family("ion", "Ion");
    const inv = await send("/v1/connections/invitations", pop.parent.auth);
    expect(inv.status).toBe(201);
    const { code, expiresAt } = await inv.json<{ code: string; expiresAt: string }>();
    expect(code).toMatch(/^zkc_[A-Za-z0-9_-]{43}$/);
    expect((Date.parse(expiresAt) - Date.now()) / 3_600_000).toBeGreaterThan(71.9);
    const res = await send("/v1/connections/accept", ion.parent.auth, { code });
    expect(res.status).toBe(201);
    const connection = await res.json<Connection>();
    expect(connection.family).toEqual({
      id: pop.familyId,
      name: "Pop",
      parents: [{ id: pop.parent.id, displayName: "ANA" }],
    });
    expect(connection.sharedKids).toEqual({ mine: [], theirs: [] });
    // Both sides list it, each seeing the other family.
    expect((await list(pop.parent.auth)).map((c) => [c.id, c.family.id])).toEqual([[connection.id, ion.familyId]]);
    expect((await list(ion.parent.auth)).map((c) => [c.id, c.family.id])).toEqual([[connection.id, pop.familyId]]);
    expect(await events()).toMatchObject([
      {
        type: "connection.created",
        connectionId: connection.id,
        familyIds: expect.arrayContaining([pop.familyId, ion.familyId]) as unknown,
      },
    ]);
  });

  it("a used, expired or unknown code → 410", async () => {
    const pop = await family("ana", "Pop");
    const ion = await family("ion", "Ion");
    const eve = await family("eve", "Eve");
    const { code } = await (await send("/v1/connections/invitations", pop.parent.auth)).json<{ code: string }>();
    expect((await send("/v1/connections/accept", ion.parent.auth, { code })).status).toBe(201);
    const used = await send("/v1/connections/accept", eve.parent.auth, { code });
    expect(used.status).toBe(410);
    expect(await errorCode(used)).toBe("invitation_invalid");
    const second = await (await send("/v1/connections/invitations", pop.parent.auth)).json<{ code: string }>();
    await env.DB.prepare("UPDATE connection_invitations SET expires_at = ? WHERE used_at IS NULL")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    expect((await send("/v1/connections/accept", eve.parent.auth, { code: second.code })).status).toBe(410);
    expect((await send("/v1/connections/accept", eve.parent.auth, { code: `zkc_${"A".repeat(43)}` })).status).toBe(410);
    expect(await count("family_connections")).toBe(1);
  });

  it("a family can't connect to itself, nor twice to the same family → 409, code stays unused", async () => {
    const pop = await family("ana", "Pop");
    const ion = await family("ion", "Ion");
    const own = await (await send("/v1/connections/invitations", pop.parent.auth)).json<{ code: string }>();
    const self = await send("/v1/connections/accept", pop.parent.auth, { code: own.code });
    expect(self.status).toBe(409);
    expect(await errorCode(self)).toBe("own_family");
    await connect(pop, ion);
    const again = await (await send("/v1/connections/invitations", pop.parent.auth)).json<{ code: string }>();
    const twice = await send("/v1/connections/accept", ion.parent.auth, { code: again.code });
    expect(twice.status).toBe(409);
    expect(await errorCode(twice)).toBe("already_connected");
    const open = await env.DB.prepare("SELECT count(*) AS n FROM connection_invitations WHERE used_at IS NULL").first<{
      n: number;
    }>();
    expect(open?.n).toBe(2);
  });

  it("needs a family on both sides → 409 no_family", async () => {
    const lone = await signInParent(apple, "lone");
    expect((await send("/v1/connections/invitations", lone.auth)).status).toBe(409);
    const pop = await family("ana", "Pop");
    const { code } = await (await send("/v1/connections/invitations", pop.parent.auth)).json<{ code: string }>();
    const res = await send("/v1/connections/accept", lone.auth, { code });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("no_family");
  });

  it("at most 5 open invitations per family → 429", async () => {
    const pop = await family("ana", "Pop");
    for (let i = 0; i < 5; i++) expect((await send("/v1/connections/invitations", pop.parent.auth)).status).toBe(201);
    const res = await send("/v1/connections/invitations", pop.parent.auth);
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe("too_many_invitations");
  });

  it("the cap is per family: 25 neighbours each still connect; one at 50 → 409, code stays open", async () => {
    const pop = await family("ana", "Pop");
    const ion = await family("ion", "Ion");
    await seedConnections(pop.familyId, 25, "p");
    await seedConnections(ion.familyId, 25, "i");
    const first = await connect(pop, ion);
    expect(first.family.id).toBe(pop.familyId);

    const dan = await family("dan", "Dan");
    await seedConnections(dan.familyId, 49, "d"); // 49 + Emil = 50
    const emil = await family("emil", "Emil");
    await connect(dan, emil);
    const { code } = await (await send("/v1/connections/invitations", dan.parent.auth)).json<{ code: string }>();
    const gabi = await family("gabi", "Gabi");
    const atCap = await send("/v1/connections/accept", gabi.parent.auth, { code });
    expect(atCap.status).toBe(409);
    expect(await errorCode(atCap)).toBe("too_many_connections");
    // The other way round too: the family at the cap accepting a code from a family with room.
    const fromGabi = await (await send("/v1/connections/invitations", gabi.parent.auth)).json<{ code: string }>();
    const danAccepts = await send("/v1/connections/accept", dan.parent.auth, { code: fromGabi.code });
    expect(danAccepts.status).toBe(409);
    expect(await errorCode(danAccepts)).toBe("too_many_connections");
    const open = await env.DB.prepare("SELECT count(*) AS n FROM connection_invitations WHERE used_at IS NULL").first<{
      n: number;
    }>();
    expect(open?.n).toBe(2);
    expect(await count("family_connections")).toBe(25 + 25 + 1 + 49 + 1);
  });

  it("the cap holds when the count changes between the check and the claim", async () => {
    const dan = await family("dan", "Dan");
    const emil = await family("emil", "Emil");
    const { code } = await (await send("/v1/connections/invitations", dan.parent.auth)).json<{ code: string }>();
    // Dan's 50th connection lands right after the pre-check, before the claim batch: the claim itself refuses.
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await seedConnections(dan.familyId, 50, "late");
      return batch(statements);
    });
    const res = await send("/v1/connections/accept", emil.parent.auth, { code });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("too_many_connections");
    expect(await count("family_connections")).toBe(50);
    const open = await env.DB.prepare("SELECT used_at FROM connection_invitations").first<{ used_at: string | null }>();
    expect(open?.used_at).toBeNull();
  });

  it("without a session → 401", async () => {
    expect((await call("/v1/connections")).status).toBe(401);
    expect((await send("/v1/connections/invitations", {})).status).toBe(401);
  });

  it("a malformed code → 400", async () => {
    const pop = await family("ana", "Pop");
    expect((await send("/v1/connections/accept", pop.parent.auth, { code: "x" })).status).toBe(400);
  });
});

describe("shared kids", () => {
  it("each family shares its own kids; the other family sees only nickname and avatar", async () => {
    const pop = await family("ana", "Pop", "Mia");
    const ion = await family("ion", "Ion", "Leo");
    const c = await connect(pop, ion);
    expect(
      (await send(`/v1/connections/${c.id}/shared-kids/${pop.kidId}`, pop.parent.auth, undefined, "PUT")).status,
    ).toBe(204);
    // Idempotent.
    expect(
      (await send(`/v1/connections/${c.id}/shared-kids/${pop.kidId}`, pop.parent.auth, undefined, "PUT")).status,
    ).toBe(204);
    const [mine] = await list(pop.parent.auth);
    expect(mine?.sharedKids).toEqual({ mine: [pop.kidId], theirs: [] });
    const [theirs] = await list(ion.parent.auth);
    expect(theirs?.sharedKids).toEqual({ mine: [], theirs: [{ id: pop.kidId, nickname: "Mia", avatar: "robot-4" }] });
    expect((await events()).map((e) => e.type)).toEqual(["connection.created", "connection.kid_shared"]);
    expect((await events())[1]).toMatchObject({ connectionId: c.id, kidAccountId: pop.kidId });
  });

  it("a family can't share the other family's kid, nor a kid of a connection it isn't in → 404", async () => {
    const pop = await family("ana", "Pop");
    const ion = await family("ion", "Ion");
    const eve = await family("eve", "Eve");
    const c = await connect(pop, ion);
    expect(
      (await send(`/v1/connections/${c.id}/shared-kids/${ion.kidId}`, pop.parent.auth, undefined, "PUT")).status,
    ).toBe(404);
    expect(
      (await send(`/v1/connections/${c.id}/shared-kids/${eve.kidId}`, eve.parent.auth, undefined, "PUT")).status,
    ).toBe(404);
    expect(await count("connection_shared_kids")).toBe(0);
  });

  it("unsharing removes the kid from the other family's view; repeating is a no-op", async () => {
    const pop = await family("ana", "Pop");
    const ion = await family("ion", "Ion");
    const c = await connect(pop, ion);
    await send(`/v1/connections/${c.id}/shared-kids/${pop.kidId}`, pop.parent.auth, undefined, "PUT");
    expect(
      (await send(`/v1/connections/${c.id}/shared-kids/${pop.kidId}`, pop.parent.auth, undefined, "DELETE")).status,
    ).toBe(204);
    expect(
      (await send(`/v1/connections/${c.id}/shared-kids/${pop.kidId}`, pop.parent.auth, undefined, "DELETE")).status,
    ).toBe(204);
    expect((await list(ion.parent.auth))[0]?.sharedKids.theirs).toEqual([]);
    expect((await events()).map((e) => e.type)).toEqual([
      "connection.created",
      "connection.kid_shared",
      "connection.kid_unshared",
    ]);
  });
});

describe("removing a connection", () => {
  it("either family removes it; shared kids go with it; the other family can't see it any more", async () => {
    const pop = await family("ana", "Pop");
    const ion = await family("ion", "Ion");
    const c = await connect(pop, ion);
    await send(`/v1/connections/${c.id}/shared-kids/${pop.kidId}`, pop.parent.auth, undefined, "PUT");
    expect((await send(`/v1/connections/${c.id}`, ion.parent.auth, undefined, "DELETE")).status).toBe(204);
    expect(await list(pop.parent.auth)).toEqual([]);
    expect(await count("connection_shared_kids")).toBe(0);
    expect((await events()).at(-1)).toMatchObject({ type: "connection.removed", connectionId: c.id });
    expect((await send(`/v1/connections/${c.id}`, ion.parent.auth, undefined, "DELETE")).status).toBe(404);
  });

  it("an outsider → 404", async () => {
    const pop = await family("ana", "Pop");
    const ion = await family("ion", "Ion");
    const eve = await family("eve", "Eve");
    const c = await connect(pop, ion);
    expect((await send(`/v1/connections/${c.id}`, eve.parent.auth, undefined, "DELETE")).status).toBe(404);
    expect(await count("family_connections")).toBe(1);
  });
});

describe("membership scopes", () => {
  it("connection:<id> holds both families' parents and the shared kids", async () => {
    const pop = await family("ana", "Pop");
    const ion = await family("ion", "Ion");
    const c = await connect(pop, ion);
    await send(`/v1/connections/${c.id}/shared-kids/${pop.kidId}`, pop.parent.auth, undefined, "PUT");
    const members = await membersOf(env, `connection:${c.id}`);
    expect(members).toEqual(
      expect.arrayContaining([
        { accountId: pop.parent.id, role: "parent" },
        { accountId: ion.parent.id, role: "parent" },
        { accountId: pop.kidId, role: "kid" },
      ]),
    );
    expect(members).toHaveLength(3);
    expect(await conversationScopes(env, pop.kidId)).toEqual([`family:${pop.familyId}`, `connection:${c.id}`]);
    expect(await conversationScopes(env, ion.kidId)).toEqual([`family:${ion.familyId}`]);
    expect(await conversationScopes(env, ion.parent.id)).toEqual([`family:${ion.familyId}`, `connection:${c.id}`]);
  });
});
