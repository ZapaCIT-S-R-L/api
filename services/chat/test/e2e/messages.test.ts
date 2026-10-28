// Envelopes end to end: send over HTTP, live delivery over the WebSocket stream, ack, and the queue for devices
// that weren't connected. Local only (needs the fake account service and the membership hook).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bearer,
  chat,
  CHAT_URL,
  eventually,
  family,
  fakeAccountService,
  LIVE,
  seedFamily,
  type AccountService,
} from "./base";

let account: AccountService;
const f = family(`${Date.now().toString(36)}m`);

interface Conversation {
  id: string;
  members: { accountId: string; devices: { deviceId: number; registrationId: number }[] }[];
}

beforeAll(async () => {
  account = await fakeAccountService();
  if (!LIVE) await seedFamily(f);
});

afterAll(async () => {
  await account.close();
});

const json = (token: string, extra: RequestInit = {}): RequestInit => ({
  ...extra,
  headers: bearer(token, { "content-type": "application/json" }),
});

function envelopes(c: Conversation, sender: string, content: string) {
  return c.members.flatMap((m) =>
    m.devices
      .filter((d) => !(m.accountId === sender && d.deviceId === 1))
      .map((d) => ({
        recipientAccountId: m.accountId,
        recipientDeviceId: d.deviceId,
        recipientRegistrationId: d.registrationId,
        type: "message",
        content,
      })),
  );
}

describe.skipIf(LIVE)("messages and stream", () => {
  it("delivers live to a connected device, queues for the others, acks delete copies", async () => {
    const mum = await account.sign({ sub: f.mum });
    let conversation: Conversation | undefined;
    await eventually(async () => {
      const res = await chat(
        "/v1/conversations",
        json(mum, { method: "POST", body: JSON.stringify({ members: [f.alex] }) }),
      );
      if (res.status >= 300) return false;
      conversation = (await res.json()) as Conversation;
      return conversation.members.every((m) => m.devices.length > 0);
    });
    const c = conversation as Conversation;

    const alexToken = await account.sign({ sub: f.alex, role: "kid" });
    const ws = new WebSocket(`${CHAT_URL.replace(/^http/, "ws")}/v1/conversations/${c.id}/stream`, {
      headers: bearer(alexToken),
    } as unknown as string[]);
    const frames: { type: string; envelope?: { id: string; content: string } }[] = [];
    ws.addEventListener("message", (m) => frames.push(JSON.parse(String(m.data)) as (typeof frames)[number]));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => {
        resolve();
      });
      ws.addEventListener("error", () => {
        reject(new Error("stream did not open"));
      });
    });

    const content = Buffer.from("sealed bytes").toString("base64");
    const sent = await chat(
      `/v1/conversations/${c.id}/messages`,
      json(mum, {
        method: "POST",
        body: JSON.stringify({ messageId: crypto.randomUUID(), envelopes: envelopes(c, f.mum, content) }),
      }),
    );
    expect(sent.status).toBe(202);
    await eventually(() => Promise.resolve(frames.length === 1));
    expect(frames[0]?.envelope?.content).toBe(content);

    ws.send(JSON.stringify({ type: "ack", envelopeIds: [frames[0]?.envelope?.id] }));
    await eventually(async () => {
      const res = await chat(`/v1/conversations/${c.id}/messages`, { headers: bearer(alexToken) });
      return ((await res.json()) as { envelopes: unknown[] }).envelopes.length === 0;
    });
    ws.close();

    // Dad wasn't connected: his copy waits.
    const dad = await account.sign({ sub: f.dad });
    const queued = (await (await chat(`/v1/conversations/${c.id}/messages`, { headers: bearer(dad) })).json()) as {
      envelopes: { content: string }[];
    };
    expect(queued.envelopes.map((e) => e.content)).toEqual([content]);
  });

  it("a stale device list is refused (409)", async () => {
    const mum = await account.sign({ sub: f.mum });
    const res = await chat(
      "/v1/conversations",
      json(mum, { method: "POST", body: JSON.stringify({ members: [f.alex] }) }),
    );
    const c = (await res.json()) as Conversation;
    const sent = await chat(
      `/v1/conversations/${c.id}/messages`,
      json(mum, {
        method: "POST",
        body: JSON.stringify({ messageId: crypto.randomUUID(), envelopes: envelopes(c, f.mum, "AAAA").slice(1) }),
      }),
    );
    expect(sent.status).toBe(409);
  });
});
