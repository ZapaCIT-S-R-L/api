// Parent oversight per kid (api #94): any parent of the kid's family turns it off or on with
// PUT /v1/families/{familyId}/kids/{kidId}/oversight. It is on by default. The change is one membership event
// (kid.oversight_changed) for the chat service, written only when the value really changed.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, makeIssuer, resetJwksCache, signInParent, stubJwks, type ErrorBody, type TestIssuer } from "./helpers";

interface Kid {
  id: string;
  nickname: string;
  oversight: boolean;
}
interface Family {
  id: string;
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

type Auth = Record<string, string>;

function send(path: string, auth: Auth, body?: unknown, method = "POST"): Promise<Response> {
  return call(path, {
    method,
    headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function family(sub: string) {
  const parent = await signInParent(apple, sub, sub.toUpperCase());
  const { id } = await (await send("/v1/families", parent.auth, { name: sub })).json<{ id: string }>();
  const kid = await (
    await send(`/v1/families/${id}/kids`, parent.auth, { nickname: "Mia", avatar: "robot-4" })
  ).json<Kid>();
  return { parent, familyId: id, kidId: kid.id };
}

async function pairKid(parentAuth: Auth, familyId: string, kidId: string): Promise<Auth> {
  const created = await send(`/v1/families/${familyId}/kids/${kidId}/pairing`, parentAuth);
  const { code } = await created.json<{ code: string }>();
  const redeemed = await send("/v1/pairing/redeem", {}, { code });
  const { session } = await redeemed.json<{ session: { token: string } }>();
  return { authorization: `Bearer ${session.token}` };
}

async function oversightEvents(): Promise<{ kidAccountId: string; enabled: boolean }[]> {
  const { results } = await env.DB.prepare("SELECT body FROM membership_outbox ORDER BY seq").all<{ body: string }>();
  return results
    .map((r) => JSON.parse(r.body) as { type: string; kidAccountId: string; enabled: boolean })
    .filter((e) => e.type === "kid.oversight_changed")
    .map(({ kidAccountId, enabled }) => ({ kidAccountId, enabled }));
}

const path = (familyId: string, kidId: string) => `/v1/families/${familyId}/kids/${kidId}/oversight`;

describe("PUT /v1/families/{familyId}/kids/{kidId}/oversight", () => {
  it("is on by default, for parents and for the kid", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const kid = await pairKid(parent.auth, familyId, kidId);
    for (const auth of [parent.auth, kid]) {
      const list = await call("/v1/families", { headers: auth });
      const { families } = await list.json<{ families: Family[] }>();
      expect(families[0]?.kids[0]?.oversight).toBe(true);
    }
    expect(await oversightEvents()).toEqual([]);
  });

  it("turns it off and on again; each real change is one event", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const off = await send(path(familyId, kidId), parent.auth, { enabled: false }, "PUT");
    expect(off.status).toBe(200);
    expect(await off.json<Kid>()).toMatchObject({ id: kidId, oversight: false });
    expect(await oversightEvents()).toEqual([{ kidAccountId: kidId, enabled: false }]);

    // Repeating it is a no-op: no second event.
    expect((await send(path(familyId, kidId), parent.auth, { enabled: false }, "PUT")).status).toBe(200);
    expect(await oversightEvents()).toHaveLength(1);

    const on = await send(path(familyId, kidId), parent.auth, { enabled: true }, "PUT");
    expect(await on.json<Kid>()).toMatchObject({ oversight: true });
    expect((await oversightEvents()).map((e) => e.enabled)).toEqual([false, true]);
    const { families } = await (await call("/v1/families", { headers: parent.auth })).json<{ families: Family[] }>();
    expect(families[0]?.kids[0]?.oversight).toBe(true);
  });

  it("turning it on when it was never off writes no event", async () => {
    const { parent, familyId, kidId } = await family("ana");
    expect((await send(path(familyId, kidId), parent.auth, { enabled: true }, "PUT")).status).toBe(200);
    expect(await oversightEvents()).toEqual([]);
  });

  it("a second parent of the family may change it", async () => {
    const { parent, familyId, kidId } = await family("ana");
    const dan = await signInParent(apple, "dan", "Dan");
    const inv = await (
      await send(`/v1/families/${familyId}/parents/invitations`, parent.auth)
    ).json<{ code: string }>();
    expect((await send("/v1/families/join", dan.auth, { code: inv.code })).status).toBe(200);
    expect((await send(path(familyId, kidId), dan.auth, { enabled: false }, "PUT")).status).toBe(200);
  });

  it("another family's parent → 404, the kid → 401, no session → 401, nothing changes", async () => {
    const a = await family("ana");
    const b = await family("bob");
    const kid = await pairKid(a.parent.auth, a.familyId, a.kidId);
    expect((await send(path(a.familyId, a.kidId), b.parent.auth, { enabled: false }, "PUT")).status).toBe(404);
    expect((await send(path(a.familyId, b.kidId), a.parent.auth, { enabled: false }, "PUT")).status).toBe(404);
    expect((await send(path(a.familyId, a.kidId), kid, { enabled: false }, "PUT")).status).toBe(401);
    expect((await send(path(a.familyId, a.kidId), {}, { enabled: false }, "PUT")).status).toBe(401);
    expect(await oversightEvents()).toEqual([]);
  });

  it("a bad body → 400", async () => {
    const { parent, familyId, kidId } = await family("ana");
    for (const body of [{}, { enabled: "no" }, { enabled: null }, { enabled: false, extra: 1 }]) {
      const res = await send(path(familyId, kidId), parent.auth, body, "PUT");
      expect(res.status).toBe(400);
      expect((await res.json<ErrorBody>()).error.code).toBe("invalid_request");
    }
  });

  it("GET → 405", async () => {
    const { parent, familyId, kidId } = await family("ana");
    expect((await call(path(familyId, kidId), { headers: parent.auth })).status).toBe(405);
  });
});
