// Families end to end over HTTP (local only: needs test sign-in keys). Two parents, one family, one kid.
import { describe, expect, it } from "vitest";
import { api, bodyOf, LIVE } from "./base";
import { post, signInParent } from "./identity";

const run = Date.now().toString(36);

interface Family {
  id: string;
  parents: { id: string }[];
  kids: { id: string; nickname: string; grade: number | null }[];
}

describe("families, everywhere", () => {
  it("GET /v1/families without a session → 401", async () => {
    expect((await api("/v1/families")).status).toBe(401);
  });

  it("joining without a session → 401", async () => {
    expect((await post("/v1/families/join", { code: `zki_${"A".repeat(43)}` })).status).toBe(401);
  });
});

describe.skipIf(LIVE)("a family with two parents and a kid (local only)", () => {
  it("create, invite, join, add a kid, list", async () => {
    const ana = await signInParent(`fam-ana-${run}`, "Ana");
    const dan = await signInParent(`fam-dan-${run}`, "Dan");

    const created = await post("/v1/families", { name: "E2E" }, ana.auth);
    expect(created.status).toBe(201);
    const family = await bodyOf<Family>(created);
    expect((await post("/v1/families", {}, ana.auth)).status).toBe(200);

    const invitation = await post(`/v1/families/${family.id}/parents/invitations`, {}, ana.auth);
    expect(invitation.status).toBe(201);
    const { code } = await bodyOf<{ code: string }>(invitation);
    expect((await post("/v1/families/join", { code }, dan.auth)).status).toBe(200);
    expect((await post("/v1/families/join", { code }, dan.auth)).status).toBe(200); // already a member
    const outsider = await signInParent(`fam-eve-${run}`);
    expect((await post("/v1/families/join", { code }, outsider.auth)).status).toBe(410);

    const kid = await post(
      `/v1/families/${family.id}/kids`,
      { nickname: "Mia", avatar: "robot-3", grade: 1 },
      dan.auth,
    );
    expect(kid.status).toBe(201);
    expect((await post(`/v1/families/${family.id}/kids`, { nickname: "Mia" }, dan.auth)).status).toBe(400);
    expect((await post(`/v1/families/${family.id}/kids`, { nickname: "X", avatar: "a" }, outsider.auth)).status).toBe(
      404,
    );

    const list = await api("/v1/families", { headers: ana.auth });
    const { families } = await bodyOf<{ families: Family[] }>(list);
    expect(families).toHaveLength(1);
    expect(families[0]?.parents.map((p) => p.id).sort()).toEqual([ana.id, dan.id].sort());
    expect(families[0]?.kids).toMatchObject([{ nickname: "Mia", grade: 1 }]);
  });
});
