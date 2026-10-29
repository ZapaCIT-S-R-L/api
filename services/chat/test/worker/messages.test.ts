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

    const gone = await send(c, ALEX, {
      messageId: crypto.randomUUID(),
      envelopes: [
        { ...all[0], recipientAccountId: MUM, recipientDeviceId: 1, recipientRegistrationId: 1 },
        { ...all[0], recipientAccountId: MUM, recipientDeviceId: 2, recipientRegistrationId: 7 },
        { ...all[0], recipientAccountId: DAD, recipientDeviceId: 1, recipientRegistrationId: 101 },
      ],
    });
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({
      error: { code: "stale_registration" },
      staleDevices: [{ accountId: MUM, deviceId: 1 }],
    });
  });

  // #73: a kid's parents read the chat (their devices get every envelope) but can't write to it.
  it("an observer gets the envelopes, fetches and acks them, but can't send (403 observer_read_only)", async () => {
    const c = await conversation(MUM, [ALEX]);
    expect(c.members.find((m) => m.accountId === DAD)?.role).toBe("observer");
    const all = envelopesFor(c, MUM);
    expect(all.map((e) => e.recipientAccountId).sort()).toEqual([ALEX, DAD]);
    expect((await send(c, MUM, { messageId: crypto.randomUUID(), envelopes: all })).status).toBe(202);
    const dad = await queued(c, DAD);
    expect(dad.envelopes).toHaveLength(1);
    const ack = await as(await tok(DAD), `/v1/conversations/${c.id}/acks`, {
      method: "POST",
      body: JSON.stringify({ envelopeIds: [dad.envelopes[0]?.id] }),
    });
    expect(ack.status).toBe(204);
    const refused = await send(c, DAD, { messageId: crypto.randomUUID(), envelopes: envelopesFor(c, DAD) });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "observer_read_only" } });
    expect((await queued(c, ALEX)).envelopes).toHaveLength(1);
  });

  it("observers get no push: only the kid's offline device is woken", async () => {
    for (const [accountId, registrationId] of [
      [ALEX, 102],
      [DAD, 101],
    ] as const) {
      await applyEvent(
        env,
        durableRooms(env),
        event({
          type: "device.upserted",
          accountId,
          deviceId: 1,
          registrationId,
          push: { provider: "fcm", token: `tok-${accountId}` },
        }),
      );
    }
    const c = await conversation(MUM, [ALEX]);
    expect((await send(c, MUM, { messageId: crypto.randomUUID(), envelopes: envelopesFor(c, MUM) })).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pushed.flat().map((t) => t.accountId)).toEqual([ALEX]);
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
  async function connect(c: ConversationBody, account: string, lifetime = 600, sep?: number, dev = 1) {
    const token = await issuer.sign(
      {
        iss: "http://localhost:8787",
        aud: "chat.localhost",
        sub: account,
        dev,
        role: "parent",
        ...(sep === undefined ? {} : { sep }),
      },
      { lifetime },
    );
    const res = await as(token, `/v1/conversations/${c.id}/stream`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error("no websocket");
    const frames: { type: string; accountId?: string; deviceId?: number; envelope?: { id: string; content: string }; event?: { kind: string } }[] = [];
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

  // api #98 (ios #62): "Typing..." is ephemeral: relayed live, never stored, never echoed, rate limited per device.
  it("typing is relayed to the other members' streams, not echoed, not stored, and rate limited (1 per 3 s)", async () => {
    const c = await conversation(MUM, [ALEX]);
    const mum = await connect(c, MUM);
    const alex = await connect(c, ALEX);
    await settle();
    mum.ws.send(JSON.stringify({ type: "typing" }));
    mum.ws.send(JSON.stringify({ type: "typing" }));
    await settle();
    expect(alex.frames).toEqual([{ type: "typing", accountId: MUM, deviceId: 1 }]);
    expect(mum.frames).toEqual([]);
    expect((await queued(c, ALEX)).envelopes).toHaveLength(0);
    expect(await roomOf(env, c.id).pendingCount()).toBe(0);
    mum.ws.close();
    alex.ws.close();
  });

  // Review of #98: observers are read-only, so their typing is refused too (writers' typing still reaches them).
  it("an observer's typing is not relayed; the observer still sees the writers' typing", async () => {
    const c = await conversation(MUM, [ALEX]);
    const dad = await connect(c, DAD);
    const alex = await connect(c, ALEX);
    const mum = await connect(c, MUM);
    await settle();
    dad.ws.send(JSON.stringify({ type: "typing" }));
    await settle();
    expect(alex.frames).toEqual([]);
    expect(mum.frames).toEqual([]);
    alex.ws.send(JSON.stringify({ type: "typing" }));
    await settle();
    expect(dad.frames).toEqual([{ type: "typing", accountId: ALEX, deviceId: 1 }]);
    expect(mum.frames).toEqual([{ type: "typing", accountId: ALEX, deviceId: 1 }]);
    for (const l of [dad, alex, mum]) l.ws.close();
  });

  // Re-review of #98: the role is read again when a signal is relayed, so a socket opened as a writer stops once
  // the member is only an observer.
  it("a socket opened as a writer stops relaying typing once the member became an observer", async () => {
    const c = await conversation(MUM, [ALEX]);
    const mum = await connect(c, MUM);
    const alex = await connect(c, ALEX);
    await settle();
    await env.DB.prepare("UPDATE conversation_members SET guardian = 1 WHERE conversation_id = ?1 AND account_id = ?2")
      .bind(c.id, MUM)
      .run();
    mum.ws.send(JSON.stringify({ type: "typing" }));
    await settle();
    expect(alex.frames).toEqual([]);
    mum.ws.close();
    alex.ws.close();
  });

  it("a second device of the same account does not get its own account's typing", async () => {
    await applyEvent(
      env,
      durableRooms(env),
      event({ type: "device.upserted", accountId: MUM, deviceId: 2, registrationId: 222 }),
    );
    const c = await conversation(MUM, [ALEX]);
    const mum = await connect(c, MUM);
    const mumOther = await connect(c, MUM, 600, undefined, 2);
    await settle();
    mum.ws.send(JSON.stringify({ type: "typing" }));
    await settle();
    expect(mumOther.frames).toEqual([]);
    mum.ws.close();
    mumOther.ws.close();
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

  // api #81: a lost phone's open stream is closed when the parent signs out everywhere.
  it("account.sessions_revoked closes the streams opened with older tokens (4401), not newer ones", async () => {
    const c = await conversation(MUM, [ALEX]);
    const lost = await connect(c, MUM, 600, 1);
    const noSep = await connect(c, MUM, 600);
    const alex = await connect(c, ALEX, 600, 1);
    // A second phone of Mum that already signed in again (its token carries the new epoch).
    const fresh = await connect(c, MUM, 600, 2);
    await applyEvent(env, durableRooms(env), event({ type: "account.sessions_revoked", accountId: MUM, epoch: 2 }));
    await settle();
    expect(lost.closed).toEqual([{ code: 4401 }]);
    expect(noSep.closed).toEqual([{ code: 4401 }]);
    expect(fresh.closed).toEqual([]);
    expect(alex.closed).toEqual([]);
    // Queued copies stay for the account's phones once they sign in again (a token without sep is revoked now).
    await send(c, ALEX, { messageId: crypto.randomUUID(), envelopes: envelopesFor(c, ALEX) });
    expect((await as(await tok(MUM), `/v1/conversations/${c.id}/messages`)).status).toBe(401);
    expect((await roomOf(env, c.id).queued(c.id, MUM, 1)).envelopes.length).toBeGreaterThan(0);
    // The lost phone can't reconnect with its old token.
    const token = await issuer.sign(
      { iss: "http://localhost:8787", aud: "chat.localhost", sub: MUM, dev: 1, role: "parent", sep: 1 },
      { lifetime: 600 },
    );
    const res = await as(token, `/v1/conversations/${c.id}/stream`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(401);
    fresh.ws.close();
    alex.ws.close();
  });

  it("the stream closes (4401) once the chat token expired", async () => {
    const c = await conversation(MUM, [ALEX]);
    const alex = await connect(c, ALEX, 1);
    // The object's alarm closes it at the token's expiry; the app reconnects with a fresh token.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(alex.closed).toEqual([{ code: 4401 }]);
  });
});
