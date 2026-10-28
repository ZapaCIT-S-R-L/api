// The ChatMembership entrypoint (Workers RPC over a service binding, never public HTTP): the calls service asks it
// whether an account is a current member of a conversation, and which members and devices to ring. Observers (a
// kid's parents reading the chat, #73) are not members for calls; they are flagged so the call log can be shown.
import { exports } from "cloudflare:workers";
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
  MUM,
  seedFamilies,
  STRANGER,
  stubJwks,
  tokenFor,
  type ConversationBody,
  type Issuer,
} from "./helpers";

let issuer: Issuer;

async function create(account: string, members: string[]): Promise<ConversationBody> {
  const res = await as(await tokenFor(issuer, account), "/v1/conversations", {
    method: "POST",
    body: JSON.stringify({ members }),
  });
  if (res.status !== 201) throw new Error(`create answered ${res.status}: ${await res.text()}`);
  return res.json<ConversationBody>();
}

const member = (conversationId: unknown, accountId: unknown) =>
  // The calls service calls it exactly like this, through its CHAT service binding.
  exports.ChatMembership.member(conversationId as string, accountId as string);

beforeEach(async () => {
  issuer = await makeIssuer();
  stubJwks(issuer);
  await seedFamilies();
});

describe("ChatMembership.member", () => {
  it("a member: member true, every current member with role and libsignal device ids (integers)", async () => {
    await apply(noRooms, { type: "device.upserted", accountId: ALEX, deviceId: 3, registrationId: 777 });
    const c = await create(MUM, [ALEX]);
    const answer = await member(c.id, ALEX);
    expect(answer).toEqual({
      member: true,
      observer: false,
      members: [
        { accountId: ALEX, role: "kid", devices: [1, 3] },
        { accountId: MUM, role: "parent", devices: [1] },
      ],
    });
  });

  it("a cross-family group: both families' writers, no observers", async () => {
    const c = await create(MUM, [ALEX, MARIA]);
    const answer = await member(c.id, MARIA);
    expect(answer?.member).toBe(true);
    expect(answer?.members.map((m) => m.accountId).sort()).toEqual([ALEX, MARIA, MUM].sort());
  });

  it("an observer: not a member for calls (not rung, no roster), but flagged so it may see the call log", async () => {
    const c = await create(MUM, [ALEX, MARIA]);
    expect(await member(c.id, ANA)).toEqual({ member: false, observer: true, members: [] });
    expect(await member(c.id, DAD)).toEqual({ member: false, observer: true, members: [] });
    expect((await member(c.id, ALEX))?.members.map((m) => m.accountId)).not.toContain(DAD);
  });

  it("an account that isn't a member: member false and no member list", async () => {
    const c = await create(MUM, [ALEX]);
    expect(await member(c.id, STRANGER)).toEqual({ member: false, observer: false, members: [] });
    expect(await member(c.id, ANA)).toEqual({ member: false, observer: false, members: [] });
  });

  it("an unknown or malformed conversation id, or arguments of the wrong type → null", async () => {
    expect(await member("c_AAAAAAAAAAAAAAAAAAAAAA", MUM)).toBeNull();
    expect(await member("not-a-conversation", MUM)).toBeNull();
    expect(await member(42, MUM)).toBeNull();
    const c = await create(MUM, [ALEX]);
    expect(await member(c.id, 42)).toEqual({ member: false, observer: false, members: [] });
    expect(await member(c.id, "x".repeat(65))).toEqual({ member: false, observer: false, members: [] });
  });

  it("a member removed from the conversation (left the family) is no longer a member, nor rung", async () => {
    const c = await create(MUM, [ALEX, MARIA]);
    expect((await member(c.id, MARIA))?.member).toBe(true);
    await apply(noRooms, { type: "family.member_removed", familyId: "fam2", accountId: MARIA });
    expect(await member(c.id, MARIA)).toEqual({ member: false, observer: false, members: [] });
    expect((await member(c.id, MUM))?.members.map((m) => m.accountId)).not.toContain(MARIA);
    // Ana observed Maria only; she is out too.
    expect(await member(c.id, ANA)).toEqual({ member: false, observer: false, members: [] });
  });

  it("a closed (read-only) conversation has no callable members, and no observers either", async () => {
    const c = await create(MUM, [ALEX, MARIA]);
    await apply(noRooms, { type: "connection.removed", connectionId: "con12" });
    expect(await member(c.id, MUM)).toEqual({ member: false, observer: false, members: [] });
    expect(await member(c.id, DAD)).toEqual({ member: false, observer: false, members: [] });
  });

  it("a member who deleted the conversation is not a member for calls, and not rung", async () => {
    const c = await create(MUM, [ALEX, MARIA]);
    const res = await as(await tokenFor(issuer, MARIA), `/v1/conversations/${c.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await member(c.id, MARIA)).toEqual({ member: false, observer: false, members: [] });
    expect((await member(c.id, MUM))?.members.map((m) => m.accountId)).toEqual([ALEX, MUM]);
    // An observer who deleted it is nothing for calls until a new message brings the conversation back.
    await as(await tokenFor(issuer, DAD), `/v1/conversations/${c.id}`, { method: "DELETE" });
    expect(await member(c.id, DAD)).toEqual({ member: false, observer: false, members: [] });
  });

  it("a member without devices is listed with no devices", async () => {
    await apply(noRooms, { type: "device.removed", accountId: ALEX, deviceId: 1 });
    const c = await create(MUM, [ALEX]);
    expect((await member(c.id, MUM))?.members.find((m) => m.accountId === ALEX)).toEqual({
      accountId: ALEX,
      role: "kid",
      devices: [],
    });
  });

  it("is not reachable over HTTP", async () => {
    const res = await as(await tokenFor(issuer, MUM), "/ChatMembership/member", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});
