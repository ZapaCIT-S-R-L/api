// Families: create (idempotent, the app calls it right after the first sign-in), list, invite a second parent,
// join by invitation code, add kids. Only members see or change a family; everyone else gets 404.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

interface Kid {
  id: string;
  nickname: string;
  avatar: string;
  grade: number | null;
  createdAt: string;
}
interface Family {
  id: string;
  name: string | null;
  createdAt: string;
  parents: { id: string; displayName: string | null }[];
  kids: Kid[];
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

async function createFamily(auth: Record<string, string>, body: unknown = {}): Promise<Family> {
  const res = await send("/v1/families", auth, body);
  expect([200, 201]).toContain(res.status);
  return res.json<Family>();
}

async function invite(auth: Record<string, string>, familyId: string): Promise<{ code: string; expiresAt: string }> {
  const res = await send(`/v1/families/${familyId}/parents/invitations`, auth);
  expect(res.status).toBe(201);
  return res.json<{ code: string; expiresAt: string }>();
}

async function errorCode(res: Response): Promise<string> {
  return (await res.json<ErrorBody>()).error.code;
}

describe("POST /v1/families", () => {
  it("without a session → 401", async () => {
    const res = await call("/v1/families", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("creates a family with the caller as its first parent", async () => {
    const ana = await signInParent(apple, "ana", "Ana");
    const res = await send("/v1/families", ana.auth, { name: "Familia Pop" });
    expect(res.status).toBe(201);
    const family = await res.json<Family>();
    expect(family.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(family.name).toBe("Familia Pop");
    expect(family.parents).toEqual([{ id: ana.id, displayName: "Ana" }]);
    expect(family.kids).toEqual([]);
  });

  it("works without a body", async () => {
    const ana = await signInParent(apple, "ana");
    const res = await send("/v1/families", ana.auth);
    expect(res.status).toBe(201);
    expect((await res.json<Family>()).name).toBeNull();
  });

  it("is idempotent: a parent already in a family gets it back (200), no second family", async () => {
    const ana = await signInParent(apple, "ana");
    const first = await createFamily(ana.auth);
    const res = await send("/v1/families", ana.auth, { name: "Other" });
    expect(res.status).toBe(200);
    expect((await res.json<Family>()).id).toBe(first.id);
    expect(await count("families")).toBe(1);
  });

  it("rejects a bad name and unknown fields → 400", async () => {
    const ana = await signInParent(apple, "ana");
    for (const body of [{ name: "x".repeat(61) }, { name: 5 }, { name: "a\u0000b" }, { extra: 1 }]) {
      const res = await send("/v1/families", ana.auth, body);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("invalid_request");
    }
    expect(await count("families")).toBe(0);
  });
});

describe("GET /v1/families", () => {
  it("is empty before a family exists", async () => {
    const ana = await signInParent(apple, "ana");
    const res = await call("/v1/families", { headers: ana.auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ families: [] });
  });

  it("lists the caller's family only", async () => {
    const ana = await signInParent(apple, "ana");
    const bob = await signInParent(apple, "bob");
    const family = await createFamily(ana.auth);
    await createFamily(bob.auth);
    const res = await call("/v1/families", { headers: ana.auth });
    expect(await res.json()).toEqual({ families: [family] });
  });

  it("DELETE → 405", async () => {
    const ana = await signInParent(apple, "ana");
    const res = await send("/v1/families", ana.auth, undefined, "DELETE");
    expect(res.status).toBe(405);
  });
});

describe("second parent: invitation and join", () => {
  it("a member creates a one-time code valid for 72 hours", async () => {
    const ana = await signInParent(apple, "ana");
    const family = await createFamily(ana.auth);
    const { code, expiresAt } = await invite(ana.auth, family.id);
    expect(code).toMatch(/^zki_[A-Za-z0-9_-]{43}$/);
    const hours = (Date.parse(expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(71.9);
    expect(hours).toBeLessThanOrEqual(72);
    // Only the hash is stored.
    const row = await env.DB.prepare("SELECT code_hash FROM family_invitations").first<{ code_hash: string }>();
    expect(row?.code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a non-member can't invite into a family → 404", async () => {
    const ana = await signInParent(apple, "ana");
    const eve = await signInParent(apple, "eve");
    const family = await createFamily(ana.auth);
    const res = await send(`/v1/families/${family.id}/parents/invitations`, eve.auth);
    expect(res.status).toBe(404);
    expect(await count("family_invitations")).toBe(0);
  });

  it("at most 5 open invitations per family → 429", async () => {
    const ana = await signInParent(apple, "ana");
    const family = await createFamily(ana.auth);
    for (let i = 0; i < 5; i++) await invite(ana.auth, family.id);
    const res = await send(`/v1/families/${family.id}/parents/invitations`, ana.auth);
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe("too_many_invitations");
  });

  it("the invited parent joins; both see the same family", async () => {
    const ana = await signInParent(apple, "ana", "Ana");
    const dan = await signInParent(apple, "dan", "Dan");
    const family = await createFamily(ana.auth);
    const { code } = await invite(ana.auth, family.id);
    const res = await send("/v1/families/join", dan.auth, { code });
    expect(res.status).toBe(200);
    const joined = await res.json<Family>();
    expect(joined.id).toBe(family.id);
    expect(joined.parents.map((p) => p.id).sort()).toEqual([ana.id, dan.id].sort());
    const list = await (await call("/v1/families", { headers: ana.auth })).json<{ families: Family[] }>();
    expect(list.families[0]?.parents).toHaveLength(2);
  });

  it("a used code → 410, and it can't add a third parent", async () => {
    const ana = await signInParent(apple, "ana");
    const dan = await signInParent(apple, "dan");
    const eve = await signInParent(apple, "eve");
    const family = await createFamily(ana.auth);
    const { code } = await invite(ana.auth, family.id);
    expect((await send("/v1/families/join", dan.auth, { code })).status).toBe(200);
    const res = await send("/v1/families/join", eve.auth, { code });
    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe("invitation_invalid");
    expect(await count("family_parents")).toBe(2);
  });

  it("an expired or unknown code → 410", async () => {
    const ana = await signInParent(apple, "ana");
    const dan = await signInParent(apple, "dan");
    const family = await createFamily(ana.auth);
    const { code } = await invite(ana.auth, family.id);
    await env.DB.prepare("UPDATE family_invitations SET expires_at = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    expect((await send("/v1/families/join", dan.auth, { code })).status).toBe(410);
    const unknown = await send("/v1/families/join", dan.auth, { code: `zki_${"A".repeat(43)}` });
    expect(unknown.status).toBe(410);
  });

  it("a malformed code → 400", async () => {
    const dan = await signInParent(apple, "dan");
    expect((await send("/v1/families/join", dan.auth, { code: "nope" })).status).toBe(400);
    expect((await send("/v1/families/join", dan.auth, {})).status).toBe(400);
  });

  it("a parent alone in an empty family moves over; the empty family is deleted", async () => {
    const ana = await signInParent(apple, "ana");
    const dan = await signInParent(apple, "dan");
    const family = await createFamily(ana.auth);
    await createFamily(dan.auth);
    const { code } = await invite(ana.auth, family.id);
    expect((await send("/v1/families/join", dan.auth, { code })).status).toBe(200);
    expect(await count("families")).toBe(1);
  });

  it("a parent whose family has kids or another parent can't join another one → 409, code stays unused", async () => {
    const ana = await signInParent(apple, "ana");
    const dan = await signInParent(apple, "dan");
    const family = await createFamily(ana.auth);
    const dans = await createFamily(dan.auth);
    expect((await send(`/v1/families/${dans.id}/kids`, dan.auth, { nickname: "Mia", avatar: "robot-1" })).status).toBe(
      201,
    );
    const { code } = await invite(ana.auth, family.id);
    const res = await send("/v1/families/join", dan.auth, { code });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("already_in_family");
    const row = await env.DB.prepare("SELECT used_at FROM family_invitations").first<{ used_at: string | null }>();
    expect(row?.used_at).toBeNull();
  });

  it("a member using their own family's code gets the family back, the code stays unused", async () => {
    const ana = await signInParent(apple, "ana");
    const family = await createFamily(ana.auth);
    const { code } = await invite(ana.auth, family.id);
    const res = await send("/v1/families/join", ana.auth, { code });
    expect(res.status).toBe(200);
    expect((await res.json<Family>()).id).toBe(family.id);
    const row = await env.DB.prepare("SELECT used_at FROM family_invitations").first<{ used_at: string | null }>();
    expect(row?.used_at).toBeNull();
  });
});

describe("POST /v1/families/{familyId}/kids", () => {
  it("adds a kid with nickname, avatar and grade", async () => {
    const ana = await signInParent(apple, "ana");
    const family = await createFamily(ana.auth);
    const res = await send(`/v1/families/${family.id}/kids`, ana.auth, {
      nickname: "  Mia ",
      avatar: "robot-7",
      grade: 2,
    });
    expect(res.status).toBe(201);
    const kid = await res.json<Kid>();
    expect(kid).toMatchObject({ nickname: "Mia", avatar: "robot-7", grade: 2 });
    expect(kid.id).toMatch(/^[0-9a-f-]{36}$/);
    const list = await (await call("/v1/families", { headers: ana.auth })).json<{ families: Family[] }>();
    expect(list.families[0]?.kids).toEqual([kid]);
  });

  it("kindergarten is grade -1, preparatory class 0; grade may be left out", async () => {
    const ana = await signInParent(apple, "ana");
    const family = await createFamily(ana.auth);
    for (const grade of [-1, 0, 12]) {
      const res = await send(`/v1/families/${family.id}/kids`, ana.auth, { nickname: "K", avatar: "robot-1", grade });
      expect(res.status).toBe(201);
    }
    const res = await send(`/v1/families/${family.id}/kids`, ana.auth, { nickname: "K", avatar: "robot-1" });
    expect((await res.json<Kid>()).grade).toBeNull();
  });

  it("validates the fields → 400", async () => {
    const ana = await signInParent(apple, "ana");
    const family = await createFamily(ana.auth);
    const bad = [
      {},
      { nickname: "", avatar: "robot-1" },
      { nickname: "   ", avatar: "robot-1" },
      { nickname: "x".repeat(41), avatar: "robot-1" },
      { nickname: "a\nb", avatar: "robot-1" },
      { nickname: "Mia" },
      { nickname: "Mia", avatar: "Robot 1" },
      { nickname: "Mia", avatar: "robot-1", grade: 13 },
      { nickname: "Mia", avatar: "robot-1", grade: -2 },
      { nickname: "Mia", avatar: "robot-1", grade: 1.5 },
      { nickname: "Mia", avatar: "robot-1", birthday: "2019-01-01" },
    ];
    for (const body of bad) {
      const res = await send(`/v1/families/${family.id}/kids`, ana.auth, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await count("kids")).toBe(0);
  });

  it("a non-member or an unknown family → 404", async () => {
    const ana = await signInParent(apple, "ana");
    const eve = await signInParent(apple, "eve");
    const family = await createFamily(ana.auth);
    const kid = { nickname: "Mia", avatar: "robot-1" };
    expect((await send(`/v1/families/${family.id}/kids`, eve.auth, kid)).status).toBe(404);
    expect((await send(`/v1/families/${crypto.randomUUID()}/kids`, ana.auth, kid)).status).toBe(404);
    expect(await count("kids")).toBe(0);
  });

  it("a second parent can add kids too", async () => {
    const ana = await signInParent(apple, "ana");
    const dan = await signInParent(apple, "dan");
    const family = await createFamily(ana.auth);
    const { code } = await invite(ana.auth, family.id);
    await send("/v1/families/join", dan.auth, { code });
    const res = await send(`/v1/families/${family.id}/kids`, dan.auth, { nickname: "Leo", avatar: "robot-2" });
    expect(res.status).toBe(201);
  });

  it("at most 12 kids per family → 409", async () => {
    const ana = await signInParent(apple, "ana");
    const family = await createFamily(ana.auth);
    for (let i = 0; i < 12; i++) {
      await send(`/v1/families/${family.id}/kids`, ana.auth, { nickname: `K${i}`, avatar: "robot-1" });
    }
    const res = await send(`/v1/families/${family.id}/kids`, ana.auth, { nickname: "K", avatar: "robot-1" });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("too_many_kids");
  });

  it("GET → 405", async () => {
    const ana = await signInParent(apple, "ana");
    const family = await createFamily(ana.auth);
    expect((await call(`/v1/families/${family.id}/kids`, { headers: ana.auth })).status).toBe(405);
  });
});

describe("replacing an adult's phone: an invitation for that parent", () => {
  it("a member creates a code for a parent of the family; 404 for a non-member parent", async () => {
    const ana = await signInParent(apple, "ana", "Ana");
    const family = await createFamily(ana.auth);
    const bob = await signInParent(apple, "bob", "Bob");
    const outsider = await signInParent(apple, "eve", "Eve");
    expect((await send(`/v1/families/${family.id}/parents/invitations`, ana.auth, { replaces: bob.id })).status).toBe(
      404,
    );
    const res = await send(`/v1/families/${family.id}/parents/invitations`, ana.auth, { replaces: outsider.id });
    expect(res.status).toBe(404);
  });

  it("the parent joins on the new phone with the code: the old sessions and devices go, the new session stays", async () => {
    const ana = await signInParent(apple, "ana", "Ana");
    const family = await createFamily(ana.auth);
    const bob = await signInParent(apple, "bob", "Bob");
    // Bob joins first; then his phone is replaced.
    const code = await invite(ana.auth, family.id);
    expect((await send("/v1/families/join", bob.auth, { code: code.code })).status).toBe(200);

    const created = await send(`/v1/families/${family.id}/parents/invitations`, ana.auth, { replaces: bob.id });
    expect(created.status).toBe(201);
    const { code: replacement } = await created.json<{ code: string }>();

    const newPhone = await signInParent(apple, "bob", "Bob");
    const joined = await send("/v1/families/join", newPhone.auth, { code: replacement });
    expect(joined.status).toBe(200);
    expect((await joined.json<Family>()).parents.map((p) => p.id).sort()).toEqual([ana.id, bob.id].sort());
    expect((await call("/v1/families", { headers: bob.auth })).status).toBe(401);
    expect((await call("/v1/families", { headers: newPhone.auth })).status).toBe(200);
    expect((await call("/v1/families", { headers: ana.auth })).status).toBe(200);
  });

  it("another parent's session can't use a replacement code → 403, the code stays usable", async () => {
    const ana = await signInParent(apple, "ana", "Ana");
    const family = await createFamily(ana.auth);
    const bob = await signInParent(apple, "bob", "Bob");
    await send("/v1/families/join", bob.auth, { code: (await invite(ana.auth, family.id)).code });
    const { code } = await (
      await send(`/v1/families/${family.id}/parents/invitations`, ana.auth, { replaces: bob.id })
    ).json<{ code: string }>();
    const carl = await signInParent(apple, "carl", "Carl");
    const res = await send("/v1/families/join", carl.auth, { code });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("invitation_for_other_account");
    expect((await send("/v1/families/join", bob.auth, { code })).status).toBe(200);
  });
});

describe("DELETE /v1/families/{familyId}/parents/{accountId}", () => {
  async function twoParents() {
    const ana = await signInParent(apple, "ana", "Ana");
    const family = await createFamily(ana.auth);
    const bob = await signInParent(apple, "bob", "Bob");
    expect((await send("/v1/families/join", bob.auth, { code: (await invite(ana.auth, family.id)).code })).status).toBe(
      200,
    );
    return { ana, bob, family };
  }

  it("a parent removes the other parent: 204; the removed parent's sessions are gone, the family stays", async () => {
    const { ana, bob, family } = await twoParents();
    const bobSecond = await signInParent(apple, "bob", "Bob");
    const res = await send(`/v1/families/${family.id}/parents/${bob.id}`, ana.auth, undefined, "DELETE");
    expect(res.status).toBe(204);
    expect((await call("/v1/families", { headers: bob.auth })).status).toBe(401);
    expect((await call("/v1/families", { headers: bobSecond.auth })).status).toBe(401);
    const mine = await (await call("/v1/families", { headers: ana.auth })).json<{ families: Family[] }>();
    expect(mine.families[0]?.parents.map((p) => p.id)).toEqual([ana.id]);
    // The removed parent has no family now; the account itself stays and can sign in again.
    const again = await signInParent(apple, "bob", "Bob");
    const fresh = await (await call("/v1/families", { headers: again.auth })).json<{ families: Family[] }>();
    expect(fresh.families).toEqual([]);
  });

  it("a parent can't remove themselves → 409 cannot_remove_self, nothing changes", async () => {
    const { ana, family } = await twoParents();
    const res = await send(`/v1/families/${family.id}/parents/${ana.id}`, ana.auth, undefined, "DELETE");
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("cannot_remove_self");
    expect((await call("/v1/families", { headers: ana.auth })).status).toBe(200);
  });

  it("a non-member caller, or a target that isn't a parent of the family → 404", async () => {
    const { ana, bob, family } = await twoParents();
    const outsider = await signInParent(apple, "eve", "Eve");
    expect((await send(`/v1/families/${family.id}/parents/${bob.id}`, outsider.auth, undefined, "DELETE")).status).toBe(
      404,
    );
    expect((await send(`/v1/families/${family.id}/parents/${outsider.id}`, ana.auth, undefined, "DELETE")).status).toBe(
      404,
    );
  });

  it("without a session → 401", async () => {
    const { bob, family } = await twoParents();
    expect((await call(`/v1/families/${family.id}/parents/${bob.id}`, { method: "DELETE" })).status).toBe(401);
  });

  it("the removed parent's family events are sent (family.member_removed, and sessions revoked)", async () => {
    const { ana, bob, family } = await twoParents();
    await send(`/v1/families/${family.id}/parents/${bob.id}`, ana.auth, undefined, "DELETE");
    const { results } = await env.DB.prepare("SELECT body FROM membership_outbox ORDER BY seq").all<{ body: string }>();
    const events = results.map((r) => JSON.parse(r.body) as { type: string; accountId?: string });
    expect(events).toContainEqual(expect.objectContaining({ type: "family.member_removed", accountId: bob.id }));
    expect(events).toContainEqual(expect.objectContaining({ type: "account.sessions_revoked", accountId: bob.id }));
    expect(await count("family_parents")).toBe(1);
  });
});
