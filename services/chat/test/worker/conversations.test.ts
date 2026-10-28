// Conversations and the family rules: parents and kids start them, kids' parents read along as observers (unless
// oversight is off for that kid), other families' kids only when shared through a connection.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { noRooms } from "../../src/rooms";
import {
  ALEX,
  ANA,
  apply,
  as,
  DAD,
  makeIssuer,
  MARIA,
  memberIds,
  MUM,
  SAM,
  seedFamilies,
  STRANGER,
  stubJwks,
  tokenFor,
  type ConversationBody,
  type Issuer,
} from "./helpers";

let issuer: Issuer;
const token = (account: string, role = "parent", dev = 1) => tokenFor(issuer, account, { role, dev });

async function create(account: string, members: string[]): Promise<Response> {
  return as(await token(account), "/v1/conversations", { method: "POST", body: JSON.stringify({ members }) });
}

beforeEach(async () => {
  issuer = await makeIssuer();
  stubJwks(issuer);
});

describe("POST /v1/conversations", () => {
  beforeEach(async () => {
    await seedFamilies();
  });

  it("a parent and their kid: direct, and the other parent joins as observer", async () => {
    const res = await create(MUM, [ALEX]);
    expect(res.status).toBe(201);
    const body = await res.json<ConversationBody>();
    expect(body.id).toMatch(/^c_[A-Za-z0-9_-]{22}$/);
    expect(body.kind).toBe("direct");
    expect(body.state).toBe("open");
    expect(memberIds(body)).toEqual([ALEX, DAD, MUM].sort());
    expect(body.members.find((m) => m.accountId === DAD)).toMatchObject({ guardian: true, role: "observer" });
    expect(body.members.find((m) => m.accountId === ALEX)).toMatchObject({ guardian: false, role: "kid" });
    // A parent who is in the conversation in their own right writes like anyone else.
    expect(body.members.find((m) => m.accountId === MUM)).toMatchObject({ guardian: false, role: "parent" });
    expect(body.members.find((m) => m.accountId === MUM)?.devices).toEqual([{ deviceId: 1, registrationId: 100 }]);
  });

  it("the same direct conversation is returned again (200), not duplicated", async () => {
    const first = await (await create(MUM, [ALEX])).json<ConversationBody>();
    const again = await create(MUM, [ALEX]);
    expect(again.status).toBe(200);
    expect((await again.json<ConversationBody>()).id).toBe(first.id);
  });

  it("a group across connected families includes every kid's parents as observers", async () => {
    const res = await create(MUM, [ALEX, MARIA]);
    expect(res.status).toBe(201);
    const body = await res.json<ConversationBody>();
    expect(body.kind).toBe("group");
    expect(memberIds(body)).toEqual([ALEX, ANA, DAD, MARIA, MUM].sort());
    expect(
      body.members
        .filter((m) => m.role === "observer")
        .map((m) => m.accountId)
        .sort(),
    ).toEqual([ANA, DAD]);
  });

  // Stefan, 2026-10-27 (#73): oversight is on by default and parents can turn it off per kid.
  it("oversight off for a kid: its parents aren't added; a sibling with oversight on still brings them", async () => {
    await apply(
      noRooms,
      { type: "family.member_added", familyId: "fam1", accountId: SAM, role: "kid" },
      { type: "device.upserted", accountId: SAM, deviceId: 1, registrationId: 200 },
      { type: "connection.kid_shared", connectionId: "con12", kidAccountId: SAM },
      { type: "kid.oversight_changed", kidAccountId: ALEX, enabled: false },
    );
    const alone = await (await create(ALEX, [MARIA])).json<ConversationBody>();
    expect(memberIds(alone)).toEqual([ALEX, ANA, MARIA].sort());
    const withSam = await (await create(ALEX, [SAM, MARIA])).json<ConversationBody>();
    expect(memberIds(withSam)).toEqual([ALEX, ANA, DAD, MARIA, MUM, SAM].sort());
    await apply(noRooms, { type: "kid.oversight_changed", kidAccountId: ALEX, enabled: true });
    const again = await (await create(ALEX, [ANA])).json<ConversationBody>();
    expect(memberIds(again)).toEqual([ALEX, ANA, DAD, MUM].sort());
  });

  // Stefan, 2026-10-28: kids start chats too ("alex can't initiate a chat with a parent" was a bug). The family
  // graph still decides who may be in it, and the kids' parents are always added.
  it("a kid starts a chat with their own parent; the other parent joins as observer", async () => {
    const res = await create(ALEX, [MUM]);
    expect(res.status).toBe(201);
    const body = await res.json<ConversationBody>();
    expect(body.kind).toBe("direct");
    expect(memberIds(body)).toEqual([ALEX, DAD, MUM].sort());
    expect(body.members.find((m) => m.accountId === DAD)).toMatchObject({ guardian: true, role: "observer" });
    expect(body.members.find((m) => m.accountId === ALEX)).toMatchObject({ guardian: false, role: "kid" });
  });

  it("a kid and a parent get the same direct conversation, whoever starts it", async () => {
    const byMum = await (await create(MUM, [ALEX])).json<ConversationBody>();
    const byAlex = await create(ALEX, [MUM]);
    expect(byAlex.status).toBe(200);
    expect((await byAlex.json<ConversationBody>()).id).toBe(byMum.id);
  });

  it("a kid starts a chat with a sibling; both parents are added as observers", async () => {
    await apply(
      noRooms,
      { type: "family.member_added", familyId: "fam1", accountId: SAM, role: "kid" },
      { type: "device.upserted", accountId: SAM, deviceId: 1, registrationId: 200 },
    );
    const res = await create(ALEX, [SAM]);
    expect(res.status).toBe(201);
    const body = await res.json<ConversationBody>();
    expect(memberIds(body)).toEqual([ALEX, DAD, MUM, SAM].sort());
    expect(
      body.members
        .filter((m) => m.guardian)
        .map((m) => m.accountId)
        .sort(),
    ).toEqual([DAD, MUM].sort());
  });

  it("a kid starts a chat with a shared kid of a connected family; every kid's parents are added", async () => {
    const res = await create(ALEX, [MARIA]);
    expect(res.status).toBe(201);
    expect(memberIds(await res.json<ConversationBody>())).toEqual([ALEX, ANA, DAD, MARIA, MUM].sort());
  });

  it("a kid can't start a chat outside the allowed family graph", async () => {
    const res = await create(ALEX, [STRANGER]);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "not_allowed" } });
    expect((await create(ALEX, ["acc_nobody"])).status).toBe(403);
  });

  it("an account in no family can't start conversations", async () => {
    expect((await create("acc_nobody", [MUM])).status).toBe(403);
  });

  it("not with an unconnected family", async () => {
    expect((await create(MUM, [STRANGER])).status).toBe(403);
  });

  it("not with an unknown account (same answer as not allowed)", async () => {
    const res = await create(MUM, ["acc_nobody"]);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "not_allowed" } });
  });

  it("validates the body", async () => {
    for (const members of [[], [MUM], [ALEX, ALEX], ["bad id!"], Array.from({ length: 32 }, (_, i) => `a${i}`)]) {
      expect((await create(MUM, members)).status, JSON.stringify(members)).toBe(400);
    }
    const extra = await as(await token(MUM), "/v1/conversations", {
      method: "POST",
      body: JSON.stringify({ members: [ALEX], title: "plaintext title" }),
    });
    expect(extra.status).toBe(400);
    const notJson = await as(await token(MUM), "/v1/conversations", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x",
    });
    expect(notJson.status).toBe(415);
  });
});

describe("GET /v1/contacts (discovery)", () => {
  const contacts = async (account: string, role = "parent") => {
    const res = await as(await token(account, role), "/v1/contacts");
    expect(res.status).toBe(200);
    const body = await res.json<{ contacts: { accountId: string; role: string; familyId: string }[] }>();
    return body.contacts;
  };

  it("a kid sees its family and the shared kids (and parents) of connected families, ids only", async () => {
    await seedFamilies();
    const alex = await contacts(ALEX, "kid");
    expect(alex.map((c) => c.accountId).sort()).toEqual([ANA, DAD, MARIA, MUM].sort());
    expect(alex.find((c) => c.accountId === MARIA)).toEqual({ accountId: MARIA, role: "kid", familyId: "fam2" });
    expect(alex.find((c) => c.accountId === MUM)).toEqual({ accountId: MUM, role: "parent", familyId: "fam1" });
    expect(JSON.stringify(alex)).not.toMatch(/name|avatar/);
  });

  it("an unshared kid isn't listed, and doesn't see the other family; a lone family sees nobody", async () => {
    await seedFamilies();
    await apply(noRooms, { type: "connection.kid_unshared", connectionId: "con12", kidAccountId: MARIA });
    expect((await contacts(ALEX, "kid")).map((c) => c.accountId).sort()).toEqual([ANA, DAD, MUM].sort());
    expect((await contacts(MARIA, "kid")).map((c) => c.accountId)).toEqual([ANA]);
    expect(await contacts(STRANGER)).toEqual([]);
    expect(await contacts("acc_nobody")).toEqual([]);
  });

  it("a parent sees the connected family's parents and shared kids", async () => {
    await seedFamilies();
    expect((await contacts(ANA)).map((c) => c.accountId).sort()).toEqual([ALEX, DAD, MARIA, MUM].sort());
    await apply(noRooms, { type: "connection.removed", connectionId: "con12" });
    expect((await contacts(ANA)).map((c) => c.accountId)).toEqual([MARIA]);
  });
});

describe("connections and sharing", () => {
  it("another family's kid needs to be shared", async () => {
    await seedFamilies(undefined, { share: false });
    expect((await create(MUM, [MARIA])).status).toBe(403);
    // Parents of connected families may talk without kids.
    expect((await create(MUM, [ANA])).status).toBe(201);
  });

  it("a kid can't start a chat with another family's kid who isn't shared", async () => {
    await seedFamilies(undefined, { share: false });
    expect((await create(ALEX, [MARIA])).status).toBe(403);
  });
});

describe("GET and DELETE /v1/conversations/{id}", () => {
  beforeEach(async () => {
    await seedFamilies();
  });

  it("members see it, others get 404", async () => {
    const { id } = await (await create(MUM, [ALEX])).json<ConversationBody>();
    expect((await as(await token(ALEX, "kid"), `/v1/conversations/${id}`)).status).toBe(200);
    expect((await as(await token(ANA), `/v1/conversations/${id}`)).status).toBe(404);
    expect((await as(await token(MUM), "/v1/conversations/c_doesnotexist0000000000")).status).toBe(404);
    expect((await as(await token(MUM), "/v1/conversations/bad")).status).toBe(404);
  });

  it("lists the caller's conversations", async () => {
    const a = await (await create(MUM, [ALEX])).json<ConversationBody>();
    const b = await (await create(MUM, [ANA])).json<ConversationBody>();
    const res = await as(await token(MUM), "/v1/conversations");
    const { conversations } = await res.json<{ conversations: ConversationBody[] }>();
    expect(conversations.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    const alex = await (
      await as(await token(ALEX, "kid"), "/v1/conversations")
    ).json<{ conversations: ConversationBody[] }>();
    expect(alex.conversations.map((c) => c.id)).toEqual([a.id]);
  });

  it("delete hides it for that account only; when every member deleted it, nothing is kept", async () => {
    const { id } = await (await create(MUM, [ANA])).json<ConversationBody>();
    expect((await as(await token(MUM), `/v1/conversations/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await as(await token(MUM), `/v1/conversations/${id}`)).status).toBe(404);
    expect((await as(await token(ANA), `/v1/conversations/${id}`)).status).toBe(200);
    expect((await as(await token(ANA), `/v1/conversations/${id}`, { method: "DELETE" })).status).toBe(204);
    const row = await env.DB.prepare("SELECT count(*) AS n FROM conversation_members WHERE conversation_id = ?1")
      .bind(id)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
    expect(await env.DB.prepare("SELECT id FROM conversations WHERE id = ?1").bind(id).first()).toBeNull();
  });

  it("after deleting a direct chat, starting it again makes a new one", async () => {
    const first = await (await create(MUM, [ANA])).json<ConversationBody>();
    await as(await token(MUM), `/v1/conversations/${first.id}`, { method: "DELETE" });
    const again = await create(MUM, [ANA]);
    expect(again.status).toBe(201);
    expect((await again.json<ConversationBody>()).id).not.toBe(first.id);
  });

  it("wrong method: 405 with Allow", async () => {
    const res = await as(await token(MUM), "/v1/conversations", { method: "PUT" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, GET");
  });
});
