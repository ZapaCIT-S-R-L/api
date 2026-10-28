// Conversations and the family rules: parents and kids start them, kids' parents are always in, other families' kids
// only when shared through a connection.
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

  it("a parent and their kid: direct, and the other parent joins as guardian", async () => {
    const res = await create(MUM, [ALEX]);
    expect(res.status).toBe(201);
    const body = await res.json<ConversationBody>();
    expect(body.id).toMatch(/^c_[A-Za-z0-9_-]{22}$/);
    expect(body.kind).toBe("direct");
    expect(body.state).toBe("open");
    expect(memberIds(body)).toEqual([ALEX, DAD, MUM].sort());
    expect(body.members.find((m) => m.accountId === DAD)).toMatchObject({ guardian: true, role: "parent" });
    expect(body.members.find((m) => m.accountId === ALEX)).toMatchObject({ guardian: false, role: "kid" });
    expect(body.members.find((m) => m.accountId === MUM)?.devices).toEqual([{ deviceId: 1, registrationId: 100 }]);
  });

  it("the same direct conversation is returned again (200), not duplicated", async () => {
    const first = await (await create(MUM, [ALEX])).json<ConversationBody>();
    const again = await create(MUM, [ALEX]);
    expect(again.status).toBe(200);
    expect((await again.json<ConversationBody>()).id).toBe(first.id);
  });

  it("a group across connected families includes every kid's parents", async () => {
    const res = await create(MUM, [ALEX, MARIA]);
    expect(res.status).toBe(201);
    const body = await res.json<ConversationBody>();
    expect(body.kind).toBe("group");
    expect(memberIds(body)).toEqual([ALEX, ANA, DAD, MARIA, MUM].sort());
  });

  // Stefan, 2026-10-28: kids start chats too ("alex can't initiate a chat with a parent" was a bug). The family
  // graph still decides who may be in it, and the kids' parents are always added.
  it("a kid starts a chat with their own parent; the other parent joins as guardian", async () => {
    const res = await create(ALEX, [MUM]);
    expect(res.status).toBe(201);
    const body = await res.json<ConversationBody>();
    expect(body.kind).toBe("direct");
    expect(memberIds(body)).toEqual([ALEX, DAD, MUM].sort());
    expect(body.members.find((m) => m.accountId === DAD)).toMatchObject({ guardian: true, role: "parent" });
    expect(body.members.find((m) => m.accountId === ALEX)).toMatchObject({ guardian: false, role: "kid" });
  });

  it("a kid and a parent get the same direct conversation, whoever starts it", async () => {
    const byMum = await (await create(MUM, [ALEX])).json<ConversationBody>();
    const byAlex = await create(ALEX, [MUM]);
    expect(byAlex.status).toBe(200);
    expect((await byAlex.json<ConversationBody>()).id).toBe(byMum.id);
  });

  it("a kid starts a chat with a sibling; both parents are added as guardians", async () => {
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
