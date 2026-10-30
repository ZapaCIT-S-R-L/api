// Membership events (Queue): applied once, unknown types ignored, malformed ones retried into the dead-letter
// queue; graph changes re-apply the family rules to existing conversations.
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_OBSERVERS, reconcile } from "../../src/conversations";
import worker from "../../src/index";
import { applyEvent, parseEvent, revokedBefore } from "../../src/membership";
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
      { type: "kid.oversight_changed", kidAccountId: "a", enabled: false },
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
      { type: "account.sessions_revoked", accountId: "a", epoch: 1 },
    ];
    for (const body of valid) expect(parseEvent(event(body)), body.type).not.toBeNull();
    for (const epoch of [0, -1, 1.5, "1", undefined]) {
      expect(() => parseEvent(event({ type: "account.sessions_revoked", accountId: "a", epoch }))).toThrow();
    }
    expect(() => parseEvent(event({ type: "connection.created", connectionId: "c", familyIds: ["f", "f"] }))).toThrow();
    expect(() =>
      parseEvent(event({ type: "device.upserted", accountId: "a", deviceId: 200, registrationId: 1 })),
    ).toThrow();
    expect(() => parseEvent(event({ type: "kid.oversight_changed", kidAccountId: "a", enabled: "no" }))).toThrow();
    // Oversight changes are ordered by occurredAt too (api #99): it must be a date.
    const undatedOversight = {
      ...event({ type: "kid.oversight_changed", kidAccountId: "a", enabled: true }),
      occurredAt: "soon",
    };
    expect(() => parseEvent(undatedOversight)).toThrow();
    // Device events are ordered by occurredAt (api #90): it must be a date.
    const undated = { ...event({ type: "device.removed", accountId: "a", deviceId: 2 }), occurredAt: "soon" };
    expect(() => parseEvent(undated)).toThrow();
  });
});

describe("graph changes and existing conversations", () => {
  it("a new parent joins the conversations of the family's kids as observer", async () => {
    await seedFamilies();
    const c = await create(MUM, [ALEX]);
    const rooms = recordingRooms();
    await apply(rooms, { type: "family.member_added", familyId: "fam1", accountId: "acc_step", role: "parent" });
    const after = await get(MUM, c.id);
    expect(after?.members.find((m) => m.accountId === "acc_step")).toMatchObject({ guardian: true, role: "observer" });
    expect(rooms.log).toContain(`notify ${c.id} members_changed`);
  });

  // #73: oversight off takes the kid's parents out of the kid's chats (their streams close, the kids re-key);
  // on again brings them back, and the kid's device re-seals the history to them.
  it("oversight off removes the kid's observers, on again adds them back; other kids' observers stay", async () => {
    await seedFamilies();
    const c = await create(ALEX, [MARIA]);
    const rooms = recordingRooms();
    await apply(rooms, { type: "kid.oversight_changed", kidAccountId: ALEX, enabled: false });
    let after = await get(ANA, c.id);
    expect(after?.state).toBe("open");
    expect(memberIds(after as ConversationBody)).toEqual([ALEX, ANA, MARIA].sort());
    expect(rooms.log).toContain(`forgetAccount ${c.id} ${MUM}`);
    expect(rooms.log).toContain(`forgetAccount ${c.id} ${DAD}`);
    expect(rooms.log.some((l) => l.startsWith(`notify ${c.id} members_changed -`))).toBe(true);
    expect(await get(MUM, c.id)).toBeNull();

    rooms.log.length = 0;
    await apply(rooms, { type: "kid.oversight_changed", kidAccountId: ALEX, enabled: true });
    after = await get(MUM, c.id);
    expect(memberIds(after as ConversationBody)).toEqual([ALEX, ANA, DAD, MARIA, MUM].sort());
    expect(after?.members.find((m) => m.accountId === MUM)?.role).toBe("observer");
    expect(rooms.log).toEqual([`notify ${c.id} members_changed`]);
  });

  // api #99 review: delivery is unordered, so an older oversight change must not overwrite a newer one.
  it("oversight: a late older change is ignored (off then on, delivered on first), a newer one applies", async () => {
    await seedFamilies();
    const c = await create(ALEX, [MARIA]);
    const rooms = recordingRooms();
    const at = (iso: string, enabled: boolean) =>
      applyEvent(env, rooms, {
        ...event({ type: "kid.oversight_changed", kidAccountId: ALEX, enabled }),
        occurredAt: iso,
      });
    const observers = async () => memberIds((await get(ANA, c.id)) as ConversationBody).includes(MUM);

    await at("2026-10-29T10:00:02.000Z", true);
    await at("2026-10-29T10:00:01.000Z", false);
    expect(await observers()).toBe(true);

    await at("2026-10-29T10:00:03.000Z", false);
    expect(await observers()).toBe(false);
    await at("2026-10-29T10:00:02.500Z", true);
    expect(await observers()).toBe(false);
  });

  it("oversight off keeps a parent who is a writer; the chat stays open", async () => {
    await seedFamilies();
    const c = await create(MUM, [ALEX]);
    await apply(recordingRooms(), { type: "kid.oversight_changed", kidAccountId: ALEX, enabled: false });
    const after = await get(MUM, c.id);
    expect(after?.state).toBe("open");
    expect(memberIds(after as ConversationBody)).toEqual([ALEX, MUM].sort());
  });

  it("an observer who stops being a parent of the kid is removed (left the family)", async () => {
    await seedFamilies();
    const c = await create(ALEX, [MARIA]);
    await apply(recordingRooms(), { type: "family.member_removed", familyId: "fam1", accountId: DAD });
    expect(memberIds((await get(MUM, c.id)) as ConversationBody)).toEqual([ALEX, ANA, MARIA, MUM].sort());
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

  it("a 1:1 whose other writer is gone closes even though observers remain", async () => {
    await seedFamilies();
    const c = await create(MUM, [ALEX]);
    await apply(recordingRooms(), { type: "account.deleted", accountId: MUM });
    const after = await get(DAD, c.id);
    expect(after?.state).toBe("closed");
    expect(memberIds(after as ConversationBody)).toEqual([ALEX, DAD].sort());
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

  // api #90: delivery is at least once and unordered; the membership backfill (account migration 0013) queued a
  // device.upserted for every device, which can arrive after a later device.removed of that device.
  it("devices: an upsert older than the device's removal does not bring it back; a newer upsert does", async () => {
    await seedFamilies();
    const c = await create(MUM, [ANA]);
    const rooms = recordingRooms();
    const at = (iso: string, body: Record<string, unknown>) =>
      applyEvent(env, rooms, { ...event(body), occurredAt: iso });
    const anaDevices = async () => (await get(MUM, c.id))?.members.find((m) => m.accountId === ANA)?.devices;
    const backfill = { type: "device.upserted", accountId: ANA, deviceId: 2, registrationId: 500 };

    await at("2026-10-28T10:00:01.000Z", { type: "device.removed", accountId: ANA, deviceId: 2 });
    await at("2026-10-28T10:00:00.000Z", backfill);
    await at("2026-10-28T10:00:01.000Z", backfill); // the same millisecond: the removal wins
    expect(await anaDevices()).toEqual([{ deviceId: 1, registrationId: 103 }]);
    expect(rooms.log.filter((l) => l === `notify ${c.id} devices_changed`)).toHaveLength(1);

    // The device is registered again after its removal.
    await at("2026-10-28T10:00:02.000Z", { ...backfill, registrationId: 600 });
    expect(await anaDevices()).toEqual([
      { deviceId: 1, registrationId: 103 },
      { deviceId: 2, registrationId: 600 },
    ]);
    // An older upsert of a live device doesn't overwrite a newer one; a redelivery of the newest still applies.
    await at("2026-10-28T10:00:00.500Z", backfill);
    await at("2026-10-28T10:00:02.000Z", { ...backfill, registrationId: 600 });
    expect(await anaDevices()).toContainEqual({ deviceId: 2, registrationId: 600 });

    // device.removed stays authoritative, even when it is older than the last upsert.
    await at("2026-10-28T10:00:01.500Z", { type: "device.removed", accountId: ANA, deviceId: 2 });
    expect(await anaDevices()).toEqual([{ deviceId: 1, registrationId: 103 }]);
    // An older removal never lowers the tombstone.
    await at("2026-10-28T10:00:00.000Z", { type: "device.removed", accountId: ANA, deviceId: 2 });
    await at("2026-10-28T10:00:01.000Z", backfill);
    expect(await anaDevices()).toEqual([{ deviceId: 1, registrationId: 103 }]);
  });

  // api #91 review: a removal older than the last upsert must not forget that upsert's timestamp.
  it("devices: a delayed removal keeps the newer upsert's timestamp, so a stale upsert stays ignored", async () => {
    await seedFamilies();
    const c = await create(MUM, [ANA]);
    const rooms = recordingRooms();
    const at = (iso: string, body: Record<string, unknown>) =>
      applyEvent(env, rooms, { ...event(body), occurredAt: iso });
    const anaDevices = async () => (await get(MUM, c.id))?.members.find((m) => m.accountId === ANA)?.devices;
    const upsert = { type: "device.upserted", accountId: ANA, deviceId: 2, registrationId: 500 };

    await at("2026-10-28T10:00:03.000Z", upsert);
    await at("2026-10-28T10:00:02.000Z", { type: "device.removed", accountId: ANA, deviceId: 2 });
    await at("2026-10-28T10:00:02.500Z", upsert);
    expect(await anaDevices()).toEqual([{ deviceId: 1, registrationId: 103 }]);

    // A later registration still applies, and a newer removal still removes it.
    await at("2026-10-28T10:00:04.000Z", { ...upsert, registrationId: 600 });
    expect(await anaDevices()).toContainEqual({ deviceId: 2, registrationId: 600 });
    await at("2026-10-28T10:00:05.000Z", { type: "device.removed", accountId: ANA, deviceId: 2 });
    expect(await anaDevices()).toEqual([{ deviceId: 1, registrationId: 103 }]);
  });

  // api #81: after a logout-all, the account's chat tokens from before the new epoch are refused.
  it("account.sessions_revoked keeps the highest epoch and closes the account's older streams", async () => {
    await seedFamilies();
    const c = await create(MUM, [ALEX]);
    const rooms = recordingRooms();
    await apply(rooms, { type: "account.sessions_revoked", accountId: MUM, epoch: 2 });
    expect(rooms.log).toEqual([`revokeSessions ${c.id} ${MUM} 2`]);
    expect(await revokedBefore(env, MUM)).toBe(2);
    // Out of order: an older event never lowers the epoch.
    await apply(rooms, { type: "account.sessions_revoked", accountId: MUM, epoch: 1 });
    expect(await revokedBefore(env, MUM)).toBe(2);
    expect(rooms.log.at(-1)).toBe(`revokeSessions ${c.id} ${MUM} 2`);
    await apply(rooms, { type: "account.sessions_revoked", accountId: MUM, epoch: 3 });
    expect(await revokedBefore(env, MUM)).toBe(3);
    expect(await revokedBefore(env, DAD)).toBe(0);
    // A revoked token no longer works; one from the new epoch does.
    expect((await as(await tokenFor(issuer, MUM, { sep: 2 }), `/v1/conversations/${c.id}`)).status).toBe(401);
    expect((await as(await tokenFor(issuer, MUM, { sep: 3 }), `/v1/conversations/${c.id}`)).status).toBe(200);
    await apply(rooms, { type: "account.deleted", accountId: MUM });
    expect(await revokedBefore(env, MUM)).toBe(0);
  });

  // MAX_OBSERVERS is enforced when the graph changes too, not only at creation (review of api #87).
  it("a new parent that would exceed MAX_OBSERVERS isn't added; the conversation closes instead", async () => {
    const parents = Array.from({ length: MAX_OBSERVERS }, (_, i) => `acc_p${i}`);
    for (const accountId of [...parents, "acc_k1", "acc_k2"]) {
      await apply(
        recordingRooms(),
        {
          type: "family.member_added",
          familyId: "famx",
          accountId,
          role: accountId.startsWith("acc_p") ? "parent" : "kid",
        },
        { type: "device.upserted", accountId, deviceId: 1, registrationId: 1 },
      );
    }
    const c = await create("acc_k1", ["acc_k2"]);
    expect(c.members.filter((m) => m.role === "observer")).toHaveLength(MAX_OBSERVERS);

    const rooms = recordingRooms();
    await apply(rooms, { type: "family.member_added", familyId: "famx", accountId: "acc_extra", role: "parent" });
    const after = await get("acc_k1", c.id);
    expect(after?.state).toBe("closed");
    expect(after?.members.map((m) => m.accountId)).not.toContain("acc_extra");
    expect(after?.members.filter((m) => m.role === "observer")).toHaveLength(MAX_OBSERVERS);
    expect(rooms.log).toContain(`notify ${c.id} conversation_closed`);
    expect(await get("acc_extra", c.id)).toBeNull();

    // Under the cap again, a closed conversation stays as it is: closed ones never gain observers.
    await apply(rooms, { type: "family.member_removed", familyId: "famx", accountId: "acc_p0" });
    expect((await get("acc_k1", c.id))?.members.map((m) => m.accountId)).not.toContain("acc_extra");
  });

  it("reconcile is a no-op on a healthy conversation", async () => {
    await seedFamilies();
    const c = await create(MUM, [ALEX, MARIA]);
    const rooms = recordingRooms();
    await reconcile(env, rooms, c.id);
    expect(rooms.log).toEqual([]);
  });
});
