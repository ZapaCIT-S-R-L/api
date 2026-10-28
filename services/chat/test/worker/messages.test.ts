// Sealed envelopes: one per current device of every member (except the sending device), queued per device until
// acknowledged, delivered live over the conversation's stream, content-free pushes for the others.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyEvent } from "../../src/membership";
import { usePushProvider, type PushTarget } from "../../src/push";
import { durableRooms, roomOf } from "../../src/room";
import {
  ALEX,
  ANA,
  as,
  DAD,
  event,
  makeIssuer,
  MUM,
  seedFamilies,
  stubJwks,
  tokenFor,
  type ConversationBody,
  type Issuer,
} from "./helpers";

let issuer: Issuer;
let pushed: PushTarget[][];
const tok = (account: string, dev = 1, role = "parent") => tokenFor(issuer, account, { dev, role });
const CIPHER = btoa("not really ciphertext, the server can't tell");

beforeEach(async () => {
  issuer = await makeIssuer();
  stubJwks(issuer);
  await seedFamilies(durableRooms(env));
  pushed = [];
  usePushProvider({
    wake: (targets) => {
      pushed.push(targets);
      return Promise.resolve();
    },
  });
});

afterEach(() => {
  usePushProvider(null);
});

async function conversation(creator: string, members: string[]): Promise<ConversationBody> {
  const res = await as(await tok(creator), "/v1/conversations", { method: "POST", body: JSON.stringify({ members }) });
  expect(res.status).toBeLessThan(300);
  return res.json<ConversationBody>();
}

// One envelope for every device of every member but the sender's device.
function envelopesFor(c: ConversationBody, sender: string, senderDevice = 1, content = CIPHER) {
  return c.members.flatMap((m) =>
    m.devices
      .filter((d) => !(m.accountId === sender && d.deviceId === senderDevice))
      .map((d) => ({
        recipientAccountId: m.accountId,
        recipientDeviceId: d.deviceId,
        recipientRegistrationId: d.registrationId,
        type: "message",
        content,
      })),
  );
}

async function send(c: ConversationBody, sender: string, body: unknown, dev = 1): Promise<Response> {
  return as(await tok(sender, dev), `/v1/conversations/${c.id}/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

interface Queued {
  envelopes: { id: string; content: string; senderAccountId: string; messageId: string; conversationId: string }[];
  more: boolean;
}

async function queued(c: ConversationBody, account: string, dev = 1): Promise<Queued> {
  const res = await as(await tok(account, dev), `/v1/conversations/${c.id}/messages`);
  expect(res.status).toBe(200);
  return res.json<Queued>();
}

describe("POST /v1/conversations/{id}/messages", () => {
  it("queues one copy per recipient device; each device acks its own", async () => {
    const c = await conversation(MUM, [ALEX]);
    const messageId = crypto.randomUUID();
    const res = await send(c, MUM, { messageId, envelopes: envelopesFor(c, MUM) });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ messageId, serverTimestamp: expect.any(Number) as number });

    const alex = await queued(c, ALEX);
    expect(alex.envelopes).toHaveLength(1);
    expect(alex.envelopes[0]).toMatchObject({ content: CIPHER, senderAccountId: MUM, messageId, conversationId: c.id });
    expect((await queued(c, MUM)).envelopes).toHaveLength(0);

    const ack = await as(await tok(ALEX), `/v1/conversations/${c.id}/acks`, {
      method: "POST",
      body: JSON.stringify({ envelopeIds: [alex.envelopes[0]?.id] }),
    });
    expect(ack.status).toBe(204);
    expect((await queued(c, ALEX)).envelopes).toHaveLength(0);
    expect((await queued(c, DAD)).envelopes).toHaveLength(1);
  });

  it("a retry with the same messageId is not delivered twice", async () => {
    const c = await conversation(MUM, [ALEX]);
    const body = { messageId: crypto.randomUUID(), envelopes: envelopesFor(c, MUM) };
    const first = await (await send(c, MUM, body)).json<{ serverTimestamp: number }>();
    const again = await send(c, MUM, body);
    expect(again.status).toBe(202);
    expect((await again.json<{ serverTimestamp: number }>()).serverTimestamp).toBe(first.serverTimestamp);
    expect((await queued(c, ALEX)).envelopes).toHaveLength(1);
  });

  it("409 when a device is missing or extra, 410 when a device was re-installed", async () => {
    const c = await conversation(MUM, [ALEX]);
    const all = envelopesFor(c, MUM);
    const missing = await send(c, MUM, { messageId: crypto.randomUUID(), envelopes: all.slice(1) });
    expect(missing.status).toBe(409);
    const body = await missing.json<{ error: { code: string }; missingDevices: unknown[]; extraDevices: unknown[] }>();
    expect(body.error.code).toBe("stale_devices");
    expect(body.missingDevices).toHaveLength(1);

    const extra = [...all, { ...all[0], recipientAccountId: ANA }];
    const res = await send(c, MUM, { messageId: crypto.randomUUID(), envelopes: extra });
    expect(res.status).toBe(409);
    expect((await res.json<{ extraDevices: unknown[] }>()).extraDevices).toEqual([{ accountId: ANA, deviceId: 1 }]);

    // The sending device itself must not be addressed; the sender's other devices must be.
    await applyEvent(
      env,
      durableRooms(env),
      event({ type: "device.upserted", accountId: MUM, deviceId: 2, registrationId: 7 }),
    );
    const stale = await send(c, MUM, { messageId: crypto.randomUUID(), envelopes: all });
    expect((await stale.json<{ missingDevices: unknown[] }>()).missingDevices).toEqual([
      { accountId: MUM, deviceId: 2 },
    ]);

    const reinstalled = all.map((e) => (e.recipientAccountId === ALEX ? { ...e, recipientRegistrationId: 1 } : e));
    const gone = await send(c, DAD, {
      messageId: crypto.randomUUID(),
      envelopes: [
        ...reinstalled.filter((e) => e.recipientAccountId !== DAD),
        { ...all[0], recipientAccountId: MUM, recipientDeviceId: 1, recipientRegistrationId: 100 },
        { ...all[0], recipientAccountId: MUM, recipientDeviceId: 2, recipientRegistrationId: 7 },
      ],
    });
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({
      error: { code: "stale_registration" },
      staleDevices: [{ accountId: ALEX, deviceId: 1 }],
    });
  });

  it("validates envelopes: base64, size, type, one per device", async () => {
    const c = await conversation(MUM, [ANA]);
    const [e] = envelopesFor(c, MUM);
    const cases: [unknown, number][] = [
      [{ ...e, content: "not base64!" }, 400],
      [{ ...e, type: "plaintext" }, 400],
      [{ ...e, content: btoa("x".repeat(64 * 1024 + 1)) }, 413],
      [{ ...e, extra: 1 }, 400],
    ];
    for (const [envelope, status] of cases) {
      expect((await send(c, MUM, { messageId: crypto.randomUUID(), envelopes: [envelope] })).status).toBe(status);
    }
    expect((await send(c, MUM, { messageId: crypto.randomUUID(), envelopes: [e, e] })).status).toBe(400);
    expect((await send(c, MUM, { messageId: "1", envelopes: [e] })).status).toBe(400);
    expect((await send(c, MUM, { messageId: crypto.randomUUID(), envelopes: [] })).status).toBe(400);
  });

  it("only members, only registered devices, only open conversations", async () => {
    const c = await conversation(MUM, [ANA]);
    const body = () => ({ messageId: crypto.randomUUID(), envelopes: envelopesFor(c, MUM) });
    expect((await send(c, ALEX, body())).status).toBe(404);
    const unregistered = await send(c, MUM, body(), 9);
    expect(unregistered.status).toBe(403);
    expect(await unregistered.json()).toMatchObject({ error: { code: "device_not_registered" } });
    await applyEvent(env, durableRooms(env), event({ type: "connection.removed", connectionId: "con12" }));
    const closed = await send(c, MUM, body());
    expect(closed.status).toBe(403);
    expect(await closed.json()).toMatchObject({ error: { code: "conversation_closed" } });
  });

  it("pushes only to offline devices with a push token, without content", async () => {
    await applyEvent(
      env,
      durableRooms(env),
      event({
        type: "device.upserted",
        accountId: ALEX,
        deviceId: 1,
        registrationId: 102,
        push: { provider: "apns", token: "tok-alex" },
      }),
    );
    const c = await conversation(MUM, [ALEX]);
    const res = await send(c, MUM, { messageId: crypto.randomUUID(), envelopes: envelopesFor(c, MUM) });
    expect(res.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pushed).toEqual([[{ accountId: ALEX, deviceId: 1, provider: "apns", token: "tok-alex" }]]);
  });

  it("a new message brings the conversation back for a member who deleted it", async () => {
    const c = await conversation(MUM, [ANA]);
    await as(await tok(ANA), `/v1/conversations/${c.id}`, { method: "DELETE" });
    expect((await send(c, MUM, { messageId: crypto.randomUUID(), envelopes: envelopesFor(c, MUM) })).status).toBe(202);
    expect((await as(await tok(ANA), `/v1/conversations/${c.id}`)).status).toBe(200);
  });
});

describe("retention of delivery copies", () => {
  it("deleting for me drops my copies; when everyone deleted, the object is emptied", async () => {
    const c = await conversation(MUM, [ANA]);
    await send(c, MUM, { messageId: crypto.randomUUID(), envelopes: envelopesFor(c, MUM) });
    await send(c, ANA, { messageId: crypto.randomUUID(), envelopes: envelopesFor(c, ANA) });
    expect(await roomOf(env, c.id).pendingCount()).toBe(2);
    await as(await tok(ANA), `/v1/conversations/${c.id}`, { method: "DELETE" });
    expect(await roomOf(env, c.id).pendingCount()).toBe(1);
    await as(await tok(MUM), `/v1/conversations/${c.id}`, { method: "DELETE" });
    expect(await roomOf(env, c.id).pendingCount()).toBe(0);
  });

  it("a removed device's copies are deleted", async () => {
    const c = await conversation(MUM, [ANA]);
    await send(c, MUM, { messageId: crypto.randomUUID(), envelopes: envelopesFor(c, MUM) });
    await applyEvent(env, durableRooms(env), event({ type: "device.removed", accountId: ANA, deviceId: 1 }));
    expect(await roomOf(env, c.id).pendingCount()).toBe(0);
  });
});

describe("GET /v1/conversations/{id}/stream", () => {
  async function connect(c: ConversationBody, account: string, lifetime = 600) {
    const token = await issuer.sign(
      { iss: "http://localhost:8787", aud: "chat.localhost", sub: account, dev: 1, role: "parent" },
      { lifetime },
    );
    const res = await as(token, `/v1/conversations/${c.id}/stream`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error("no websocket");
    const frames: { type: string; envelope?: { id: string; content: string }; event?: { kind: string } }[] = [];
    const closed: { code: number }[] = [];
    ws.addEventListener("message", (m) => frames.push(JSON.parse(m.data as string) as (typeof frames)[number]));
    ws.addEventListener("close", (e) => closed.push({ code: e.code }));
    ws.accept();
    return { ws, frames, closed };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  it("delivers queued envelopes on connect and new ones live; acks over the socket", async () => {
    const c = await conversation(MUM, [ALEX]);
    await send(c, MUM, { messageId: crypto.randomUUID(), envelopes: envelopesFor(c, MUM, 1, btoa("first")) });
    const alex = await connect(c, ALEX);
    await settle();
    expect(alex.frames.map((f) => f.envelope?.content)).toEqual([btoa("first")]);

    await send(c, MUM, { messageId: crypto.randomUUID(), envelopes: envelopesFor(c, MUM, 1, btoa("second")) });
    await settle();
    expect(alex.frames.map((f) => f.envelope?.content)).toEqual([btoa("first"), btoa("second")]);
    expect(pushed.flat().some((t) => t.accountId === ALEX)).toBe(false);

    alex.ws.send(JSON.stringify({ type: "ack", envelopeIds: alex.frames.map((f) => f.envelope?.id) }));
    await settle();
    expect((await queued(c, ALEX)).envelopes).toHaveLength(0);
    alex.ws.close();
  });

  it("not a WebSocket: 426; not a member: 404", async () => {
    const c = await conversation(MUM, [ALEX]);
    expect((await as(await tok(MUM), `/v1/conversations/${c.id}/stream`)).status).toBe(426);
    const res = await as(await tok(ANA), `/v1/conversations/${c.id}/stream`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(404);
  });

  it("membership changes reach the stream; a removed member's stream is closed (4403)", async () => {
    const c = await conversation(MUM, [ALEX]);
    const mum = await connect(c, MUM);
    const dad = await connect(c, DAD);
    await applyEvent(
      env,
      durableRooms(env),
      event({ type: "family.member_removed", familyId: "fam1", accountId: DAD }),
    );
    await settle();
    expect(dad.closed).toEqual([{ code: 4403 }]);
    expect(mum.frames.map((f) => f.event?.kind)).toContain("members_changed");
    mum.ws.close();
  });

  it("the stream closes (4401) once the chat token expired", async () => {
    const c = await conversation(MUM, [ALEX]);
    const alex = await connect(c, ALEX, 1);
    // The object's alarm closes it at the token's expiry; the app reconnects with a fresh token.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(alex.closed).toEqual([{ code: 4401 }]);
  });
});
