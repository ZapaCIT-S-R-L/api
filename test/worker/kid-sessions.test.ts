// Kid sessions after pairing (api #78): the kid's phone signs itself out (POST /v1/kid/logout), and a parent lists a
// kid's paired phones (one live session each) and revokes one (a lost or replaced phone). A revoked token answers
// 401 everywhere at once.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bearer,
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

interface KidSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
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

// A parent with a family and one kid.
async function parentWithKid(sub = "ana") {
  const parent = await signInParent(apple, sub);
  const family = await (await send("/v1/families", parent.auth, { name: "Pop" })).json<{ id: string }>();
  const kid = await (
    await send(`/v1/families/${family.id}/kids`, parent.auth, { nickname: "Mia", avatar: "robot-1", grade: 1 })
  ).json<{ id: string }>();
  return { parent, family, kid, sessionsPath: `/v1/families/${family.id}/kids/${kid.id}/sessions` };
}

// Pairs one phone of the kid: a kid session token.
async function pairPhone(auth: Record<string, string>, familyId: string, kidId: string): Promise<string> {
  const { code } = await (await send(`/v1/families/${familyId}/kids/${kidId}/pairing`, auth)).json<{ code: string }>();
  const res = await send("/v1/pairing/redeem", {}, { code });
  expect(res.status).toBe(200);
  return (await res.json<{ session: { token: string } }>()).session.token;
}

async function listSessions(path: string, auth: Record<string, string>): Promise<KidSession[]> {
  const res = await call(path, { headers: auth });
  expect(res.status).toBe(200);
  return (await res.json<{ sessions: KidSession[] }>()).sessions;
}

const kidLogout = (token: string) => call("/v1/kid/logout", { method: "POST", headers: bearer(token) });
const kidFamilies = (token: string) => call("/v1/families", { headers: bearer(token) });

async function expectUnauthorized(res: Response) {
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBe("Bearer");
  expect((await res.json<ErrorBody>()).error.code).toBe("unauthorized");
}

async function expectNotFound(res: Response) {
  expect(res.status).toBe(404);
  expect((await res.json<ErrorBody>()).error.code).toBe("not_found");
}

// Everything a kid session can call today answers 401 once the session is gone.
async function expectRevoked(token: string) {
  await expectUnauthorized(await kidFamilies(token));
  await expectUnauthorized(await kidLogout(token));
}

describe("POST /v1/kid/logout", () => {
  it("ends this kid session only; the kid's other phone stays paired", async () => {
    const { parent, family, kid } = await parentWithKid();
    const first = await pairPhone(parent.auth, family.id, kid.id);
    const second = await pairPhone(parent.auth, family.id, kid.id);
    const res = await kidLogout(first);
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expectRevoked(first);
    expect((await kidFamilies(second)).status).toBe(200);
    expect(await count("kid_sessions")).toBe(1);
  });

  it("twice → the second is 401", async () => {
    const { parent, family, kid } = await parentWithKid();
    const token = await pairPhone(parent.auth, family.id, kid.id);
    expect((await kidLogout(token)).status).toBe(204);
    await expectUnauthorized(await kidLogout(token));
  });

  it("without a session, with an unknown kid token, or with the stored hash → 401", async () => {
    await expectUnauthorized(await call("/v1/kid/logout", { method: "POST" }));
    await expectUnauthorized(await kidLogout(`zkk_${"A".repeat(43)}`));
    const { parent, family, kid } = await parentWithKid();
    const token = await pairPhone(parent.auth, family.id, kid.id);
    await expectUnauthorized(await kidLogout(await sha256Hex(token)));
    expect((await kidFamilies(token)).status).toBe(200);
  });

  it("a parent session → 401 (parents use /v1/auth/logout), and the parent stays signed in", async () => {
    const { parent } = await parentWithKid();
    await expectUnauthorized(await kidLogout(parent.token));
    expect((await call("/v1/me", { headers: parent.auth })).status).toBe(200);
  });

  it("an expired kid session → 401", async () => {
    const { parent, family, kid } = await parentWithKid();
    const token = await pairPhone(parent.auth, family.id, kid.id);
    await env.DB.prepare("UPDATE kid_sessions SET expires_at = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    await expectUnauthorized(await kidLogout(token));
  });

  it("GET → 405", async () => {
    const { parent, family, kid } = await parentWithKid();
    const token = await pairPhone(parent.auth, family.id, kid.id);
    const res = await call("/v1/kid/logout", { headers: bearer(token) });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("GET /v1/families/{familyId}/kids/{kidId}/sessions", () => {
  it("lists the kid's paired phones, oldest first, with ids and dates only", async () => {
    const { parent, family, kid, sessionsPath } = await parentWithKid();
    expect(await listSessions(sessionsPath, parent.auth)).toEqual([]);
    const first = await pairPhone(parent.auth, family.id, kid.id);
    const second = await pairPhone(parent.auth, family.id, kid.id);
    const res = await call(sessionsPath, { headers: parent.auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const { sessions } = JSON.parse(text) as { sessions: KidSession[] };
    expect(sessions).toHaveLength(2);
    for (const s of sessions) {
      expect(s.id).toMatch(/^[0-9a-f]{32}$/);
      expect(Object.keys(s).sort()).toEqual(["createdAt", "expiresAt", "id", "lastSeenAt"]);
      expect(s.lastSeenAt).toBe(s.createdAt);
      const days = (Date.parse(s.expiresAt) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThanOrEqual(30);
    }
    expect(sessions[0]?.id).not.toBe(sessions[1]?.id);
    expect(Date.parse(sessions[0]?.createdAt ?? "")).toBeLessThanOrEqual(Date.parse(sessions[1]?.createdAt ?? ""));
    // Never the token or its hash.
    for (const token of [first, second]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(await sha256Hex(token));
    }
  });

  it("is per kid, and any parent of the family sees it", async () => {
    const { parent, family, kid, sessionsPath } = await parentWithKid();
    const other = await (
      await send(`/v1/families/${family.id}/kids`, parent.auth, { nickname: "Leo", avatar: "robot-2", grade: 3 })
    ).json<{ id: string }>();
    await pairPhone(parent.auth, family.id, kid.id);
    await pairPhone(parent.auth, family.id, other.id);
    expect(await listSessions(sessionsPath, parent.auth)).toHaveLength(1);
    // A second parent joins the family with an invitation.
    const { code } = await (
      await send(`/v1/families/${family.id}/parents/invitations`, parent.auth)
    ).json<{ code: string }>();
    const bob = await signInParent(apple, "bob", "Bob");
    expect((await send("/v1/families/join", bob.auth, { code })).status).toBe(200);
    expect(await listSessions(sessionsPath, bob.auth)).toHaveLength(1);
  });

  it("leaves out expired sessions (and deletes them)", async () => {
    const { parent, family, kid, sessionsPath } = await parentWithKid();
    const token = await pairPhone(parent.auth, family.id, kid.id);
    await pairPhone(parent.auth, family.id, kid.id);
    await env.DB.prepare("UPDATE kid_sessions SET expires_at = ? WHERE token_hash = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), await sha256Hex(token))
      .run();
    expect(await listSessions(sessionsPath, parent.auth)).toHaveLength(1);
    expect(await count("kid_sessions")).toBe(1);
  });

  it("lastSeenAt moves to the day the phone last used its session", async () => {
    const { parent, family, kid, sessionsPath } = await parentWithKid();
    const token = await pairPhone(parent.auth, family.id, kid.id);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await env.DB.prepare("UPDATE kid_sessions SET created_at = ?, last_seen_at = ?").bind(twoDaysAgo, twoDaysAgo).run();
    expect((await listSessions(sessionsPath, parent.auth))[0]?.lastSeenAt).toBe(twoDaysAgo);
    expect((await kidFamilies(token)).status).toBe(200);
    const [seen] = await listSessions(sessionsPath, parent.auth);
    expect(Date.now() - Date.parse(seen?.lastSeenAt ?? "")).toBeLessThan(60_000);
    // Within the same day it isn't rewritten.
    expect((await kidFamilies(token)).status).toBe(200);
    expect((await listSessions(sessionsPath, parent.auth))[0]?.lastSeenAt).toBe(seen?.lastSeenAt);
  });

  // Rollback safety: a session made by the Worker version before migration 0014 has no id and no last_seen_at.
  it("names a session made by the previous Worker version when first listed", async () => {
    const { parent, family, kid, sessionsPath } = await parentWithKid();
    const token = await pairPhone(parent.auth, family.id, kid.id);
    await env.DB.prepare("UPDATE kid_sessions SET id = NULL, last_seen_at = NULL").run();
    const [session] = await listSessions(sessionsPath, parent.auth);
    expect(session?.id).toMatch(/^[0-9a-f]{32}$/);
    expect(session?.lastSeenAt).toBe(session?.createdAt);
    // The id is stable, and the session can be revoked by it.
    expect((await listSessions(sessionsPath, parent.auth))[0]?.id).toBe(session?.id);
    expect((await send(`${sessionsPath}/${session?.id}`, parent.auth, undefined, "DELETE")).status).toBe(204);
    await expectRevoked(token);
  });

  it("without a session, or with a kid session → 401", async () => {
    const { parent, family, kid, sessionsPath } = await parentWithKid();
    const token = await pairPhone(parent.auth, family.id, kid.id);
    await expectUnauthorized(await call(sessionsPath));
    await expectUnauthorized(await call(sessionsPath, { headers: bearer(token) }));
  });

  it("a non-member, a kid of another family or an unknown kid → 404", async () => {
    const ana = await parentWithKid("ana");
    const bob = await parentWithKid("bob");
    await expectNotFound(await call(ana.sessionsPath, { headers: bob.parent.auth }));
    await expectNotFound(
      await call(`/v1/families/${ana.family.id}/kids/${bob.kid.id}/sessions`, { headers: ana.parent.auth }),
    );
    await expectNotFound(
      await call(`/v1/families/${bob.family.id}/kids/${ana.kid.id}/sessions`, { headers: ana.parent.auth }),
    );
    await expectNotFound(
      await call(`/v1/families/${ana.family.id}/kids/${crypto.randomUUID()}/sessions`, { headers: ana.parent.auth }),
    );
  });

  it("POST → 405", async () => {
    const { parent, sessionsPath } = await parentWithKid();
    const res = await send(sessionsPath, parent.auth);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});

describe("DELETE /v1/families/{familyId}/kids/{kidId}/sessions/{sessionId}", () => {
  it("revokes one phone: its token → 401 everywhere, the other phone and open codes stay", async () => {
    const { parent, family, kid, sessionsPath } = await parentWithKid();
    const lost = await pairPhone(parent.auth, family.id, kid.id);
    const kept = await pairPhone(parent.auth, family.id, kid.id);
    const open = await send(`/v1/families/${family.id}/kids/${kid.id}/pairing`, parent.auth);
    expect(open.status).toBe(201);
    const [lostSession] = await listSessions(sessionsPath, parent.auth);
    const res = await send(`${sessionsPath}/${lostSession?.id}`, parent.auth, undefined, "DELETE");
    expect(res.status).toBe(204);
    await expectRevoked(lost);
    expect((await kidFamilies(kept)).status).toBe(200);
    expect((await listSessions(sessionsPath, parent.auth)).map((s) => s.id)).not.toContain(lostSession?.id);
    expect(await count("kid_sessions")).toBe(1);
    // The open code still pairs a new phone, and that one can be revoked too.
    const { code } = await open.json<{ code: string }>();
    expect((await send("/v1/pairing/redeem", {}, { code })).status).toBe(200);
    expect(await listSessions(sessionsPath, parent.auth)).toHaveLength(2);
  });

  it("the parent can revoke a phone that is mid-session: the next request of that phone is 401", async () => {
    const { parent, family, kid, sessionsPath } = await parentWithKid();
    const token = await pairPhone(parent.auth, family.id, kid.id);
    expect((await kidFamilies(token)).status).toBe(200);
    const [session] = await listSessions(sessionsPath, parent.auth);
    expect((await send(`${sessionsPath}/${session?.id}`, parent.auth, undefined, "DELETE")).status).toBe(204);
    await expectRevoked(token);
  });

  it("an unknown, malformed or already revoked id → 404", async () => {
    const { parent, family, kid, sessionsPath } = await parentWithKid();
    await pairPhone(parent.auth, family.id, kid.id);
    const [session] = await listSessions(sessionsPath, parent.auth);
    for (const id of ["0".repeat(32), "nope", "A".repeat(32), "0".repeat(31)]) {
      await expectNotFound(await send(`${sessionsPath}/${id}`, parent.auth, undefined, "DELETE"));
    }
    expect((await send(`${sessionsPath}/${session?.id}`, parent.auth, undefined, "DELETE")).status).toBe(204);
    await expectNotFound(await send(`${sessionsPath}/${session?.id}`, parent.auth, undefined, "DELETE"));
  });

  it("another kid's session id → 404, and that session stays", async () => {
    const { parent, family, sessionsPath } = await parentWithKid();
    const other = await (
      await send(`/v1/families/${family.id}/kids`, parent.auth, { nickname: "Leo", avatar: "robot-2", grade: 3 })
    ).json<{ id: string }>();
    const otherToken = await pairPhone(parent.auth, family.id, other.id);
    const [otherSession] = await listSessions(`/v1/families/${family.id}/kids/${other.id}/sessions`, parent.auth);
    await expectNotFound(await send(`${sessionsPath}/${otherSession?.id}`, parent.auth, undefined, "DELETE"));
    expect((await kidFamilies(otherToken)).status).toBe(200);
  });

  it("a non-member → 404, and the session stays", async () => {
    const ana = await parentWithKid("ana");
    const bob = await parentWithKid("bob");
    const token = await pairPhone(ana.parent.auth, ana.family.id, ana.kid.id);
    const [session] = await listSessions(ana.sessionsPath, ana.parent.auth);
    await expectNotFound(await send(`${ana.sessionsPath}/${session?.id}`, bob.parent.auth, undefined, "DELETE"));
    await expectNotFound(
      await send(
        `/v1/families/${bob.family.id}/kids/${ana.kid.id}/sessions/${session?.id}`,
        bob.parent.auth,
        undefined,
        "DELETE",
      ),
    );
    expect((await kidFamilies(token)).status).toBe(200);
  });

  it("without a session, or with a kid session (even its own) → 401", async () => {
    const { parent, family, kid, sessionsPath } = await parentWithKid();
    const token = await pairPhone(parent.auth, family.id, kid.id);
    const [session] = await listSessions(sessionsPath, parent.auth);
    await expectUnauthorized(await call(`${sessionsPath}/${session?.id}`, { method: "DELETE" }));
    await expectUnauthorized(await send(`${sessionsPath}/${session?.id}`, bearer(token), undefined, "DELETE"));
    expect((await kidFamilies(token)).status).toBe(200);
  });

  it("GET → 405", async () => {
    const { parent, sessionsPath } = await parentWithKid();
    const res = await call(`${sessionsPath}/${"0".repeat(32)}`, { headers: parent.auth });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("DELETE");
  });
});
