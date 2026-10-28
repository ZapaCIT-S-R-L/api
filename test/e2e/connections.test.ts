// Connections end to end over HTTP (local only): two families connect by code and one shares a kid.
import { describe, expect, it } from "vitest";
import { api, bodyOf, LIVE } from "./base";
import { post, signInParent } from "./identity";

const run = Date.now().toString(36);

describe("connections, everywhere", () => {
  it("GET /v1/connections without a session → 401", async () => {
    expect((await api("/v1/connections")).status).toBe(401);
  });
});

describe.skipIf(LIVE)("two families connect (local only)", () => {
  it("invite, accept, share a kid, see it, remove", async () => {
    const ana = await signInParent(`con-ana-${run}`, "Ana");
    const ion = await signInParent(`con-ion-${run}`, "Ion");
    const pop = await bodyOf<{ id: string }>(await post("/v1/families", { name: "Pop" }, ana.auth));
    await post("/v1/families", { name: "Ion" }, ion.auth);
    const kid = await bodyOf<{ id: string }>(
      await post(`/v1/families/${pop.id}/kids`, { nickname: "Mia", avatar: "robot-2" }, ana.auth),
    );

    const { code } = await bodyOf<{ code: string }>(await post("/v1/connections/invitations", {}, ana.auth));
    const accepted = await post("/v1/connections/accept", { code }, ion.auth);
    expect(accepted.status).toBe(201);
    const connection = await bodyOf<{ id: string }>(accepted);
    expect((await post("/v1/connections/accept", { code }, ion.auth)).status).toBe(410);

    const share = await api(`/v1/connections/${connection.id}/shared-kids/${kid.id}`, {
      method: "PUT",
      headers: ana.auth,
    });
    expect(share.status).toBe(204);
    const seen = await bodyOf<{ connections: { sharedKids: { theirs: { nickname: string }[] } }[] }>(
      await api("/v1/connections", { headers: ion.auth }),
    );
    expect(seen.connections[0]?.sharedKids.theirs.map((k) => k.nickname)).toEqual(["Mia"]);

    expect((await api(`/v1/connections/${connection.id}`, { method: "DELETE", headers: ion.auth })).status).toBe(204);
    const after = await bodyOf<{ connections: unknown[] }>(await api("/v1/connections", { headers: ana.auth }));
    expect(after.connections).toEqual([]);
  });
});
