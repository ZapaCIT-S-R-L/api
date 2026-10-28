// Membership events (Queue): applied once, unknown types ignored, malformed ones retried into the dead-letter
// queue; graph changes re-apply the family rules to existing conversations.
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "../../src/conversations";
import worker from "../../src/index";
import { parseEvent } from "../../src/membership";
import {
  ALEX,
  ANA,
  apply,
  as,
  DAD,
  event,
  makeIssuer,
  MARIA,
  memberIds,
  MUM,
  recordingRooms,
  seedFamilies,
  stubJwks,
  tokenFor,
  type ConversationBody,
  type Issuer,
} from "./helpers";

let issuer: Issuer;

beforeEach(async () => {
  issuer = await makeIssuer();
  stubJwks(issuer);
});

async function create(account: string, members: string[]): Promise<ConversationBody> {
  const res = await as(await tokenFor(issuer, account), "/v1/conversations", {
    method: "POST",
    body: JSON.stringify({ members }),
  });
  expect(res.status).toBe(201);
  return res.json<ConversationBody>();
}

async function get(account: string, id: string): Promise<ConversationBody | null> {
  const res = await as(await tokenFor(issuer, account), `/v1/conversations/${id}`);
  return res.status === 200 ? res.json<ConversationBody>() : null;
}

async function deliver(bodies: unknown[]) {
  const batch = createMessageBatch(
    "zapakid-membership-local",
    bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body })),
  );
  const ctx = createExecutionContext();
  await worker.queue(batch, env, ctx);
  return getQueueResult(batch, ctx);
}

describe("queue consumer", () => {
  it("applies events, acks unknown types, retries malformed ones", async () => {
    const result = await deliver([
      event({ type: "family.member_added", familyId: "f", accountId: "acc_x", role: "parent" }),
      event({ type: "family.renamed", familyId: "f" }),
      { v: 1, id: "not-a-uuid", type: "family.member_added" },
      event({ type: "family.member_added", familyId: "f", accountId: "bad id", role: "parent" }),
    ]);
    expect(result.explicitAcks.sort()).toEqual(["m0", "m1"]);
    expect(result.retryMessages.map((m) => m.msgId).sort()).toEqual(["m2", "m3"]);
    const row = await env.DB.prepare("SELECT role FROM family_members WHERE account_id = 'acc_x'").first();
    expect(row).toEqual({ role: "parent" });
  });

  it("a repeated event id is applied once", async () => {
    const added = event({ type: "family.member_added", familyId: "f", accountId: "acc_x", role: "parent" });
    await deliver([added]);
    await env.DB.prepare("DELETE FROM family_members").run();
    const result = await deliver([added]);
    expect(result.explicitAcks).toEqual(["m0"]);
    expect(await env.DB.prepare("SELECT 1 FROM family_members").first()).toBeNull();
  });

  it("parses every event type in the OpenAPI schema", () => {
    const valid = [
      { type: "family.member_added", familyId: "f", accountId: "a", role: "kid" },
      { type: "family.member_removed", familyId: "f", accountId: "a" },
      { type: "connection.created", connectionId: "c", familyIds: ["f", "g"] },
      { type: "connection.removed", connectionId: "c" },
      { type: "connection.kid_shared", connectionId: "c", kidAccountId: "a" },
      { type: "connection.kid_unshared", connectionId: "c", kidAccountId: "a" },
      {
        type: "device.upserted",
        accountId: "a",
        deviceId: 2,
        registrationId: 7,
        push: { provider: "apns", token: "t" },
      },
      { type: "device.upserted", accountId: "a", deviceId: 2, registrationId: 7, push: null },
      { type: "device.removed", accountId: "a", deviceId: 2 },
      { type: "account.deleted", accountId: "a" },
    ];
    for (const body of valid) expect(parseEvent(event(body)), body.type).not.toBeNull();
    expect(() => parseEvent(event({ type: "connection.created", connectionId: "c", familyIds: ["f", "f"] }))).toThrow();
    expect(() =>
      parseEvent(event({ type: "device.upserted", accountId: "a", deviceId: 200, registrationId: 1 })),
    ).toThrow();
  });
});

describe("graph changes and existing conversations", () => {
  it("a new parent joins the conversations of the family's kids as guardian", async () => {
    await seedFamilies();
    const c = await create(MUM, [ALEX]);
    const rooms = recordingRooms();
    await apply(rooms, { type: "family.member_added", familyId: "fam1", accountId: "acc_step", role: "parent" });
    const after = await get(MUM, c.id);
    expect(after?.members.find((m) => m.accountId === "acc_step")).toMatchObject({ guardian: true });
    expect(rooms.log).toContain(`notify ${c.id} members_changed`);
  });

  it("removing the connection closes the cross-family chats (read-only), not the family's own", async () => {
    await seedFamilies();
    const cross = await create(MUM, [ALEX, MARIA]);
    const own = await create(MUM, [ALEX]);
    const rooms = recordingRooms();
    await apply(rooms, { type: "connection.removed", connectionId: "con12" });
    expect((await get(MUM, cross.id))?.state).toBe("closed");
    expect((await get(MUM, cross.id))?.closedAt).not.toBeNull();
    expect((await get(MUM, own.id))?.state).toBe("open");
    expect(rooms.log).toContain(`notify ${cross.id} conversation_closed`);
  });

  it("unsharing a kid closes the chats with the other family", async () => {
    await seedFamilies();
    const cross = await create(ANA, [ALEX]);
    await apply(recordingRooms(), { type: "connection.kid_unshared", connectionId: "con12", kidAccountId: ALEX });
    expect((await get(ANA, cross.id))?.state).toBe("closed");
  });

  it("a parent leaving the family leaves its conversations; the chat stays open", async () => {
    await seedFamilies();
    const c = await create(MUM, [ALEX]);
    const rooms = recordingRooms();
    await apply(rooms, { type: "family.member_removed", familyId: "fam1", accountId: DAD });
    const after = await get(MUM, c.id);
    expect(after?.state).toBe("open");
    expect(memberIds(after as ConversationBody)).toEqual([ALEX, MUM].sort());
    expect(rooms.log).toContain(`forgetAccount ${c.id} ${DAD}`);
    expect(rooms.log).toContain(`notify ${c.id} members_changed -${DAD}`);
  });

  it("account deletion: removed everywhere; a 1:1 left with one member closes; with none, purged", async () => {
    await seedFamilies();
    const direct = await create(MUM, [ANA]);
    const rooms = recordingRooms();
    await apply(rooms, { type: "account.deleted", accountId: ANA });
    const after = await get(MUM, direct.id);
    expect(after?.state).toBe("closed");
    expect(memberIds(after as ConversationBody)).toEqual([MUM]);
    await apply(rooms, { type: "account.deleted", accountId: MUM });
    expect(rooms.log).toContain(`purge ${direct.id}`);
    expect(await env.DB.prepare("SELECT 1 FROM conversations WHERE id = ?1").bind(direct.id).first()).toBeNull();
  });

  it("devices: upserts and removals show in the member list and reach the conversation", async () => {
    await seedFamilies();
    const c = await create(MUM, [ANA]);
    const rooms = recordingRooms();
    await apply(rooms, { type: "device.upserted", accountId: ANA, deviceId: 2, registrationId: 999 });
    let ana = (await get(MUM, c.id))?.members.find((m) => m.accountId === ANA);
    expect(ana?.devices).toEqual([
      { deviceId: 1, registrationId: 103 },
      { deviceId: 2, registrationId: 999 },
    ]);
    await apply(rooms, { type: "device.removed", accountId: ANA, deviceId: 1 });
    ana = (await get(MUM, c.id))?.members.find((m) => m.accountId === ANA);
    expect(ana?.devices).toEqual([{ deviceId: 2, registrationId: 999 }]);
    expect(rooms.log).toContain(`forgetDevice ${c.id} ${ANA}:1`);
    expect(rooms.log.filter((l) => l === `notify ${c.id} devices_changed`)).toHaveLength(2);
  });

  it("reconcile is a no-op on a healthy conversation", async () => {
    await seedFamilies();
    const c = await create(MUM, [ALEX, MARIA]);
    const rooms = recordingRooms();
    await reconcile(env, rooms, c.id);
    expect(rooms.log).toEqual([]);
  });
});
