// Families: create (idempotent, the app calls it right after the first sign-in), list, invite a second parent,
// join by invitation code, add kids. Only members see or change a family; everyone else gets 404.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  call,
  count,
  makeIssuer,
  resetJwksCache,
  sha256Hex,
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

  // PR #108 review: two sessions of the parent redeem the same code in the same millisecond. The loser's claim
  // changes nothing, and nothing else in its batch may run: the winner's new session and device stay.
  it("a losing concurrent redemption (same millisecond) can't remove the winner's session or device", async () => {
    const ana = await signInParent(apple, "ana", "Ana");
    const family = await createFamily(ana.auth);
    const bob = await signInParent(apple, "bob", "Bob");
    await send("/v1/families/join", bob.auth, { code: (await invite(ana.auth, family.id)).code });
    const { code } = await (
      await send(`/v1/families/${family.id}/parents/invitations`, ana.auth, { replaces: bob.id })
    ).json<{ code: string }>();
    const winner = await signInParent(apple, "bob", "Bob");
    const loser = await signInParent(apple, "bob", "Bob");
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO devices (account_id, device_id, registration_id, signed_prekey_id, signed_prekey,
         signed_prekey_signature, pq_last_resort_id, pq_last_resort_key, pq_last_resort_signature, created_at, last_seen_at)
       VALUES (?, 7, 1, 1, 'k', 's', 1, 'k', 's', ?, ?)`,
    )
      .bind(bob.id, now, now)
      .run();
    await env.DB.prepare("UPDATE sessions SET device_id = 7 WHERE token_hash = ?")
      .bind(await sha256Hex(winner.token))
      .run();
    await env.DB.prepare("DELETE FROM membership_outbox").run();

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    // The loser has passed its checks; the winner redeems before the loser's batch runs, in the same millisecond.
    const batch = env.DB.batch.bind(env.DB);
    let won: Response | undefined;
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      won = await send("/v1/families/join", winner.auth, { code });
      return batch(statements);
    });
    const lost = await send("/v1/families/join", loser.auth, { code });
    vi.useRealTimers();

    expect(won?.status).toBe(200);
    expect(lost.status).toBe(410);
    expect((await call("/v1/families", { headers: winner.auth })).status).toBe(200);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM devices WHERE account_id = ?").bind(bob.id).first("n")).toBe(
      1,
    );
    const { results } = await env.DB.prepare("SELECT body FROM membership_outbox").all<{ body: string }>();
    expect(results.map((r) => JSON.parse(r.body) as { type: string; deviceId?: number })).not.toContainEqual(
      expect.objectContaining({ type: "device.removed", deviceId: 7 }),
    );
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

  // PR #108 review: another removal wins between the membership checks and the batch, leaving the target as the
  // last parent. Nothing of the batch may happen: no session or epoch change, no event at all.
  it("the target became the last parent before the batch → 409 last_parent, nothing changes, no event", async () => {
    const { ana, bob, family } = await twoParents();
    const epoch = () =>
      env.DB.prepare("SELECT session_epoch FROM parents WHERE id = ?").bind(bob.id).first("session_epoch");
    const before = await epoch();
    await env.DB.prepare("DELETE FROM membership_outbox").run();
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await env.DB.prepare("DELETE FROM family_parents WHERE parent_id = ?").bind(ana.id).run();
      return batch(statements);
    });
    const res = await send(`/v1/families/${family.id}/parents/${bob.id}`, ana.auth, undefined, "DELETE");
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("last_parent");
    expect((await call("/v1/families", { headers: bob.auth })).status).toBe(200);
    expect(await epoch()).toBe(before);
    expect(await count("family_parents")).toBe(1);
    expect(await outboxSize()).toBe(0);
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

  // PR #108 review: removing a parent revokes the family capabilities they hold, not only their sessions.
  it("a removed parent can't rejoin with an open invitation they created before removal → 410", async () => {
    const { ana, bob, family } = await twoParents();
    const { code } = await invite(bob.auth, family.id);
    const replacement = await send(`/v1/families/${family.id}/parents/invitations`, ana.auth, { replaces: bob.id });
    const { code: replacementCode } = await replacement.json<{ code: string }>();
    expect((await send(`/v1/families/${family.id}/parents/${bob.id}`, ana.auth, undefined, "DELETE")).status).toBe(204);

    const again = await signInParent(apple, "bob", "Bob");
    const own = await createFamily(again.auth);
    for (const c of [code, replacementCode]) {
      const res = await send("/v1/families/join", again.auth, { code: c });
      expect(res.status, c).toBe(410);
      expect(await errorCode(res)).toBe("invitation_invalid");
    }
    // The removed parent's open codes are gone; the used one that admitted them stays (used).
    expect(await countWhere("family_invitations", "used_at IS NULL")).toBe(0);
    const mine = await (await call("/v1/families", { headers: again.auth })).json<{ families: Family[] }>();
    expect(mine.families.map((f) => f.id)).toEqual([own.id]);
    const anas = await (await call("/v1/families", { headers: ana.auth })).json<{ families: Family[] }>();
    expect(anas.families[0]?.parents.map((p) => p.id)).toEqual([ana.id]);
  });

  it("replaying the used invitation that admitted a removed parent → 410, no family data", async () => {
    const ana = await signInParent(apple, "ana", "Ana");
    const family = await createFamily(ana.auth);
    await send(`/v1/families/${family.id}/kids`, ana.auth, { nickname: "Mia", avatar: "robot-1" });
    const bob = await signInParent(apple, "bob", "Bob");
    const { code } = await invite(ana.auth, family.id);
    expect((await send("/v1/families/join", bob.auth, { code })).status).toBe(200);
    // While a member, a retried join answers with the family (documented idempotent retry).
    expect((await send("/v1/families/join", bob.auth, { code })).status).toBe(200);
    expect((await send(`/v1/families/${family.id}/parents/${bob.id}`, ana.auth, undefined, "DELETE")).status).toBe(204);

    const again = await signInParent(apple, "bob", "Bob");
    for (const auth of [again.auth, (await signInParent(apple, "eve", "Eve")).auth]) {
      const res = await send("/v1/families/join", auth, { code });
      expect(res.status).toBe(410);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ error: { code: "invitation_invalid" } });
      expect(text).not.toContain(family.id);
      expect(text).not.toContain("Mia");
    }
    expect(await countWhere("family_parents", "family_id = ?", family.id)).toBe(1);
  });

  it("an invitation whose creator is no longer a parent of the family can't be used → 410", async () => {
    // An invite that raced the removal: inserted after the removal's batch, so the removal didn't revoke it.
    const { ana, bob, family } = await twoParents();
    const { code } = await invite(bob.auth, family.id);
    await env.DB.prepare("DELETE FROM family_parents WHERE parent_id = ?").bind(bob.id).run();
    const carol = await signInParent(apple, "carol", "Carol");
    const res = await send("/v1/families/join", carol.auth, { code });
    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe("invitation_invalid");
    expect(await countWhere("family_parents", "family_id = ?", family.id)).toBe(1);
    expect((await call("/v1/families", { headers: ana.auth })).status).toBe(200);
  });

  it("the creator is removed between the join's lookup and its claim → 410, nobody joins, no event", async () => {
    const { ana, bob, family } = await twoParents();
    const { code } = await invite(bob.auth, family.id);
    const carol = await signInParent(apple, "carol", "Carol");
    await env.DB.prepare("DELETE FROM membership_outbox").run();
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      // Only the parent row goes here (the invitation stays), so the claim's own creator check is what refuses it.
      await env.DB.prepare("DELETE FROM family_parents WHERE parent_id = ?").bind(bob.id).run();
      return batch(statements);
    });
    const res = await send("/v1/families/join", carol.auth, { code });
    expect(res.status).toBe(410);
    expect(await countWhere("family_parents", "family_id = ?", family.id)).toBe(1);
    expect(await countWhere("family_invitations", "used_at IS NULL")).toBe(1);
    expect(await outboxSize()).toBe(0);
    expect((await call("/v1/families", { headers: ana.auth })).status).toBe(200);
  });

  it("a replacement code whose parent was removed between lookup and claim deletes nothing → 410", async () => {
    const { ana, bob, family } = await twoParents();
    const created = await send(`/v1/families/${family.id}/parents/invitations`, ana.auth, { replaces: bob.id });
    const { code } = await created.json<{ code: string }>();
    const newPhone = await signInParent(apple, "bob", "Bob");
    const sessions = await countWhere("sessions", "parent_id = ?", bob.id);
    await env.DB.prepare("DELETE FROM membership_outbox").run();
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await env.DB.prepare("DELETE FROM family_parents WHERE parent_id = ?").bind(bob.id).run();
      return batch(statements);
    });
    const res = await send("/v1/families/join", newPhone.auth, { code });
    expect(res.status).toBe(410);
    expect(await countWhere("sessions", "parent_id = ?", bob.id)).toBe(sessions);
    expect(await outboxSize()).toBe(0);
  });

  it("removal revokes the removed parent's open kid pairing and connection codes", async () => {
    const { ana, bob, family } = await twoParents();
    const kid = await (
      await send(`/v1/families/${family.id}/kids`, ana.auth, { nickname: "Mia", avatar: "robot-1" })
    ).json<Kid>();
    expect((await send(`/v1/families/${family.id}/kids/${kid.id}/pairing`, bob.auth)).status).toBe(201);
    expect((await send(`/v1/families/${family.id}/kids/${kid.id}/pairing`, ana.auth)).status).toBe(201);
    expect((await send("/v1/connections/invitations", bob.auth)).status).toBe(201);
    expect((await send(`/v1/families/${family.id}/parents/${bob.id}`, ana.auth, undefined, "DELETE")).status).toBe(204);
    expect(await countWhere("kid_pairings", "created_by = ?", bob.id)).toBe(0);
    expect(await countWhere("kid_pairings", "created_by = ?", ana.id)).toBe(1);
    expect(await countWhere("connection_invitations", "created_by = ?", bob.id)).toBe(0);
  });

  it("a kid pairing code issued after its creator's removal committed isn't stored → 404", async () => {
    // The request passed its membership check, then the removal committed (revoking the creator's open codes) before
    // the code was written: the write itself must refuse it, or the code would outlive the removal.
    const { ana, bob, family } = await twoParents();
    const kid = await (
      await send(`/v1/families/${family.id}/kids`, ana.auth, { nickname: "Mia", avatar: "robot-1" })
    ).json<Kid>();
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (!sql.includes("SELECT count(*) AS n FROM kid_pairings")) return statement;
      return {
        bind: (...binds: unknown[]) => {
          const bound = statement.bind(...binds);
          return {
            first: async <T>() => {
              await prepare("DELETE FROM family_parents WHERE parent_id = ?").bind(bob.id).run();
              return bound.first<T>();
            },
          };
        },
      } as unknown as D1PreparedStatement;
    });
    const res = await send(`/v1/families/${family.id}/kids/${kid.id}/pairing`, bob.auth);
    vi.restoreAllMocks();
    expect(res.status).toBe(404);
    expect(await countWhere("kid_pairings", "created_by = ?", bob.id)).toBe(0);
  });

  it("a kid pairing code whose creator is no longer a parent of the family can't be redeemed → 410, no session", async () => {
    // A code that raced the removal: inserted after the removal's batch, so the removal didn't revoke it.
    const { ana, bob, family } = await twoParents();
    const kid = await (
      await send(`/v1/families/${family.id}/kids`, ana.auth, { nickname: "Mia", avatar: "robot-1" })
    ).json<Kid>();
    const { code } = await (
      await send(`/v1/families/${family.id}/kids/${kid.id}/pairing`, bob.auth)
    ).json<{
      code: string;
    }>();
    await env.DB.prepare("DELETE FROM family_parents WHERE parent_id = ?").bind(bob.id).run();
    const res = await send("/v1/pairing/redeem", {}, { code });
    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe("pairing_code_invalid");
    expect(await countWhere("kid_sessions", "kid_id = ?", kid.id)).toBe(0);
  });

  it("the pairing code's creator is removed between the redeem's lookup and its claim → 410, no session", async () => {
    const { ana, bob, family } = await twoParents();
    const kid = await (
      await send(`/v1/families/${family.id}/kids`, ana.auth, { nickname: "Mia", avatar: "robot-1" })
    ).json<Kid>();
    const created = await send(`/v1/families/${family.id}/kids/${kid.id}/pairing`, bob.auth, { replacePhones: true });
    const { code } = await created.json<{ code: string }>();
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await env.DB.prepare("DELETE FROM family_parents WHERE parent_id = ?").bind(bob.id).run();
      return batch(statements);
    });
    const res = await send("/v1/pairing/redeem", {}, { code });
    expect(res.status).toBe(410);
    expect(await countWhere("kid_sessions", "kid_id = ?", kid.id)).toBe(0);
    expect(await countWhere("kid_pairings", "code_hash = ? AND used_at IS NULL", await sha256Hex(code))).toBe(1);
  });
});

const countWhere = async (table: string, where: string, ...binds: unknown[]): Promise<number> =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)
    .bind(...binds)
    .first<number>("n")) ?? 0;

const outboxSize = async (): Promise<number> =>
  (await env.DB.prepare("SELECT count(*) AS n FROM membership_outbox").first<number>("n")) ?? 0;

describe("PATCH /v1/families/{familyId}/kids/{kidId}", () => {
  async function familyWithKid(sub: string) {
    const parent = await signInParent(apple, sub, sub.toUpperCase());
    const family = await createFamily(parent.auth);
    const res = await send(`/v1/families/${family.id}/kids`, parent.auth, {
      nickname: "Mia",
      avatar: "robot-3",
      grade: 1,
    });
    const kid = await res.json<Kid>();
    return { parent, familyId: family.id, kid, path: `/v1/families/${family.id}/kids/${kid.id}` };
  }

  it("renames the kid and changes the avatar; grade stays", async () => {
    const { parent, familyId, kid, path } = await familyWithKid("ana");
    const res = await send(path, parent.auth, { nickname: "  Mimi ", avatar: "robot-7" }, "PATCH");
    expect(res.status).toBe(200);
    expect(await res.json<Kid>()).toMatchObject({ id: kid.id, nickname: "Mimi", avatar: "robot-7", grade: 1 });
    const { families } = await (await call("/v1/families", { headers: parent.auth })).json<{ families: Family[] }>();
    expect(families[0]?.id).toBe(familyId);
    expect(families[0]?.kids).toMatchObject([{ nickname: "Mimi", avatar: "robot-7", grade: 1 }]);
  });

  it("one field alone is enough", async () => {
    const { parent, path } = await familyWithKid("ana");
    expect(await (await send(path, parent.auth, { nickname: "Lia" }, "PATCH")).json<Kid>()).toMatchObject({
      nickname: "Lia",
      avatar: "robot-3",
    });
    expect(await (await send(path, parent.auth, { avatar: "robot-9" }, "PATCH")).json<Kid>()).toMatchObject({
      nickname: "Lia",
      avatar: "robot-9",
    });
  });

  it("a second parent of the family may rename", async () => {
    const { parent, familyId, path } = await familyWithKid("ana");
    const dan = await signInParent(apple, "dan", "Dan");
    const { code } = await invite(parent.auth, familyId);
    expect((await send("/v1/families/join", dan.auth, { code })).status).toBe(200);
    expect((await send(path, dan.auth, { nickname: "Lia" }, "PATCH")).status).toBe(200);
  });

  it("the same validation as adding a kid → 400", async () => {
    const { parent, path } = await familyWithKid("ana");
    for (const body of [
      {},
      { nickname: "" },
      { nickname: "x".repeat(41) },
      { nickname: "two\nlines" },
      { nickname: 7 },
      { avatar: "Robot 3" },
      { avatar: "a".repeat(33) },
      { grade: 2 },
      { nickname: "Lia", extra: true },
    ]) {
      const res = await send(path, parent.auth, body, "PATCH");
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
      expect(await errorCode(res)).toBe("invalid_request");
    }
    expect(
      await call("/v1/families", { headers: parent.auth }).then((r) => r.json<{ families: Family[] }>()),
    ).toMatchObject({
      families: [{ kids: [{ nickname: "Mia", avatar: "robot-3" }] }],
    });
  });

  it("another family's parent → 404, no session → 401, nothing changes", async () => {
    const a = await familyWithKid("ana");
    const b = await familyWithKid("bob");
    expect((await send(a.path, b.parent.auth, { nickname: "Evil" }, "PATCH")).status).toBe(404);
    expect(
      (await send(`/v1/families/${a.familyId}/kids/${b.kid.id}`, a.parent.auth, { nickname: "Evil" }, "PATCH")).status,
    ).toBe(404);
    expect((await send(a.path, {}, { nickname: "Evil" }, "PATCH")).status).toBe(401);
    expect(await env.DB.prepare("SELECT nickname FROM kids WHERE id = ?").bind(a.kid.id).first("nickname")).toBe("Mia");
  });

  it("a kid's own session → 401", async () => {
    const { parent, familyId, kid, path } = await familyWithKid("ana");
    const created = await send(`/v1/families/${familyId}/kids/${kid.id}/pairing`, parent.auth);
    const { code } = await created.json<{ code: string }>();
    const redeemed = await send("/v1/pairing/redeem", {}, { code });
    const { session } = await redeemed.json<{ session: { token: string } }>();
    expect((await send(path, { authorization: `Bearer ${session.token}` }, { nickname: "Me" }, "PATCH")).status).toBe(
      401,
    );
  });

  it("writes no membership event (the chat service doesn't know names)", async () => {
    const { parent, path } = await familyWithKid("ana");
    const before = await outboxSize();
    await send(path, parent.auth, { nickname: "Lia" }, "PATCH");
    expect(await outboxSize()).toBe(before);
  });

  it("DELETE still works, other methods → 405", async () => {
    const { parent, path } = await familyWithKid("ana");
    const res = await call(path, { method: "POST", headers: parent.auth });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("PATCH, DELETE");
    expect((await send(path, parent.auth, undefined, "DELETE")).status).toBe(204);
  });
});
