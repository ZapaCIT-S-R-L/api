// Kid pairing end to end over HTTP (local only: needs test sign-in keys). A parent pairs a new kid's phone, then a
// second phone for the same kid; a reused or unknown code is refused.
import { describe, expect, it } from "vitest";
import { api, bodyOf, LIVE } from "./base";
import { post, signInParent } from "./identity";

const run = Date.now().toString(36);

describe("pairing, everywhere", () => {
  it("an unknown code → 410", async () => {
    const res = await post("/v1/pairing/redeem", { code: `zkp_${"A".repeat(43)}` });
    // Live, attestation runs first: production ("required") refuses a call without it before looking at the code.
    if (LIVE) expect([403, 410]).toContain(res.status);
    else expect(res.status).toBe(410);
  });

  it("a malformed code → 400", async () => {
    expect((await post("/v1/pairing/redeem", { code: "x" })).status).toBe(400);
  });
});

describe.skipIf(LIVE)("pair a kid's phone (local only)", () => {
  it("new kid, then a second phone for the same kid", async () => {
    const ana = await signInParent(`pair-ana-${run}`, "Ana");
    const family = await bodyOf<{ id: string }>(await post("/v1/families", {}, ana.auth));
    const kid = await bodyOf<{ id: string }>(
      await post(`/v1/families/${family.id}/kids`, { nickname: "Leo", avatar: "robot-5", grade: -1 }, ana.auth),
    );

    const first = await post(`/v1/families/${family.id}/kids/${kid.id}/pairing`, {}, ana.auth);
    expect(first.status).toBe(201);
    const { code } = await bodyOf<{ code: string }>(first);
    const redeemed = await post("/v1/pairing/redeem", { code });
    expect(redeemed.status).toBe(200);
    const { session, kid: paired } = await bodyOf<{ session: { token: string }; kid: { id: string } }>(redeemed);
    expect(paired.id).toBe(kid.id);
    expect((await post("/v1/pairing/redeem", { code })).status).toBe(410);

    const kidAuth = { authorization: `Bearer ${session.token}` };
    const families = await api("/v1/families", { headers: kidAuth });
    expect(families.status).toBe(200);
    const { families: list } = await bodyOf<{ families: { id: string }[] }>(families);
    expect(list.map((f) => f.id)).toEqual([family.id]);
    expect((await post(`/v1/families/${family.id}/kids`, { nickname: "X", avatar: "a" }, kidAuth)).status).toBe(401);

    const second = await bodyOf<{ code: string }>(
      await post(`/v1/families/${family.id}/kids/${kid.id}/pairing`, {}, ana.auth),
    );
    const again = await post("/v1/pairing/redeem", { code: second.code });
    expect(again.status).toBe(200);
    expect((await bodyOf<{ kid: { id: string } }>(again)).kid.id).toBe(kid.id);
  });
});
