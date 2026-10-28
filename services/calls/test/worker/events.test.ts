// GET /v1/calls/{id}/events: the WebSocket of a call (roster, joins and leaves, sealed key envelopes), and the
// Realtime proxy that only ever lets a phone touch its own SFU session.
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetJwksCache } from "../../src/jwks";
import { errorCode, phone, type Phone } from "./calls-helpers";
import {
  bearer,
  fakeRealtime,
  makeIssuer,
  stubFetch,
  uniqueAccount,
  type CallView,
  type FakeRealtime,
  type TestIssuer,
} from "./helpers";

let issuer: TestIssuer;
let realtime: FakeRealtime;

beforeEach(async () => {
  resetJwksCache();
  issuer = await makeIssuer();
  realtime = fakeRealtime(stubFetch([issuer]));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// A call with dad (caller) and mum (joined).
async function twoPhoneCall(): Promise<{ dad: Phone; mum: Phone; callId: string }> {
  const dad = await phone(issuer, uniqueAccount(), 1);
  const mum = await phone(issuer, uniqueAccount(), 4);
  const { call } = await dad.create();
  expect((await mum.join(call.callId)).status).toBe(200);
  return { dad, mum, callId: call.callId };
}

const blob = (n: number) => btoa(String.fromCharCode(...new Uint8Array(n).fill(7)));

describe("events WebSocket", () => {
  it("sends the roster on connect, then joined and left events with the new epoch", async () => {
    const dad = await phone(issuer, uniqueAccount());
    const mum = await phone(issuer, uniqueAccount(), 2);
    const { call } = await dad.create();
    const events = await dad.events(call.callId);
    const first = (await events.next("roster")).call as CallView;
    expect(first.participants[0]?.connected).toBe(true);

    await mum.join(call.callId);
    expect(await events.next("joined")).toMatchObject({ accountId: mum.accountId, deviceId: 2, epoch: 2 });
    expect(((await events.next("roster")).call as CallView).participants).toHaveLength(2);

    await mum.request("POST", `/v1/calls/${call.callId}/leave`);
    expect(await events.next("left")).toMatchObject({ accountId: mum.accountId, epoch: 3, reason: "left" });
    events.close();
  });

  it("refuses without a token, with a token for another conversation, and without Upgrade", async () => {
    const dad = await phone(issuer, uniqueAccount());
    const stranger = await phone(issuer, uniqueAccount(), 1, ["conv-2"]);
    const { call } = await dad.create();
    const url = `https://calls.test/v1/calls/${call.callId}/events`;
    const none = await exports.default.fetch(new Request(url, { headers: { upgrade: "websocket" } }));
    expect(none.status).toBe(401);
    const other = await exports.default.fetch(
      new Request(url, { headers: { ...bearer(stranger.token), upgrade: "websocket" } }),
    );
    expect(other.status).toBe(404);
    const plain = await exports.default.fetch(new Request(url, { headers: bearer(dad.token) }));
    expect(plain.status).toBe(426);
  });

  it("relays a sealed key envelope to the one device it is for, and nobody else", async () => {
    const { dad, mum, callId } = await twoPhoneCall();
    const grandma = await phone(issuer, uniqueAccount(), 1);
    await grandma.join(callId);
    const a = await dad.events(callId);
    const b = await mum.events(callId);
    const c = await grandma.events(callId);
    for (const s of [a, b, c]) await s.next("roster");

    a.send({
      type: "keys",
      epoch: 3,
      envelopes: [{ toAccount: mum.accountId, toDevice: 4, blob: blob(100) }],
    });
    expect(await a.next("keys_ack")).toMatchObject({ epoch: 3, delivered: 1, queued: 0 });
    expect(await b.next("key")).toEqual({
      type: "key",
      epoch: 3,
      fromAccount: dad.accountId,
      fromDevice: 1,
      blob: blob(100),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(c.messages.some((m) => m.type === "key")).toBe(false);
    for (const s of [a, b, c]) s.close();
  });

  it("queues an envelope for a participant who isn't connected yet, and delivers it on connect", async () => {
    const { dad, mum, callId } = await twoPhoneCall();
    const a = await dad.events(callId);
    await a.next("roster");
    a.send({ type: "keys", epoch: 2, envelopes: [{ toAccount: mum.accountId, toDevice: 4, blob: blob(40) }] });
    expect(await a.next("keys_ack")).toMatchObject({ delivered: 0, queued: 1 });
    const b = await mum.events(callId);
    expect(await b.next("key")).toMatchObject({ epoch: 2, fromAccount: dad.accountId, blob: blob(40) });
    a.close();
    b.close();
  });

  it("refuses envelopes for a past epoch, for non-participants, for oneself, too large or too many", async () => {
    const { dad, mum, callId } = await twoPhoneCall();
    const a = await dad.events(callId);
    await a.next("roster");
    const to = { toAccount: mum.accountId, toDevice: 4 };
    const cases: [unknown, string][] = [
      [{ type: "keys", epoch: 1, envelopes: [{ ...to, blob: blob(10) }] }, "stale_epoch"],
      [
        { type: "keys", epoch: 2, envelopes: [{ toAccount: "nobody", toDevice: 1, blob: blob(10) }] },
        "not_participant",
      ],
      [
        { type: "keys", epoch: 2, envelopes: [{ toAccount: dad.accountId, toDevice: 1, blob: blob(10) }] },
        "not_participant",
      ],
      [{ type: "keys", epoch: 2, envelopes: [{ ...to, blob: blob(4000) }] }, "invalid_message"],
      [{ type: "keys", epoch: 2, envelopes: [{ ...to, blob: "not base64!" }] }, "invalid_message"],
      [{ type: "keys", epoch: 2, envelopes: Array(9).fill({ ...to, blob: blob(10) }) }, "invalid_message"],
      [{ type: "chat", text: "hi" }, "invalid_message"],
    ];
    for (const [message, code] of cases) {
      a.send(message);
      expect(await a.next("error"), JSON.stringify(message).slice(0, 80)).toMatchObject({ code });
    }
    a.ws.send("not json");
    expect(await a.next("error")).toMatchObject({ code: "invalid_message" });
    a.close();
  });

  it("a member who hasn't joined can watch the roster but can't send keys", async () => {
    const dad = await phone(issuer, uniqueAccount());
    const mum = await phone(issuer, uniqueAccount());
    const { call } = await dad.create();
    const b = await mum.events(call.callId);
    await b.next("roster");
    b.send({ type: "keys", epoch: 1, envelopes: [{ toAccount: dad.accountId, toDevice: 1, blob: blob(10) }] });
    expect(await b.next("error")).toMatchObject({ code: "not_participant" });
    b.close();
  });

  // api #73: a kid's parents observe the chat, never the call; the call key never reaches them.
  it("refuses an observer's WebSocket (404) and key envelopes addressed to an observer", async () => {
    const alex = await phone(issuer, uniqueAccount(), 1, ["conv-obs-ws"], "kid");
    const maria = await phone(issuer, uniqueAccount(), 2, ["conv-obs-ws"], "kid");
    const mum = await phone(issuer, uniqueAccount(), 3, ["conv-obs-ws"], "observer");
    const { call } = await alex.create("conv-obs-ws");
    expect((await maria.join(call.callId)).status).toBe(200);

    const refused = await exports.default.fetch(
      new Request(`https://calls.test/v1/calls/${call.callId}/events`, {
        headers: { ...bearer(mum.token), upgrade: "websocket" },
      }),
    );
    expect(refused.status).toBe(404);
    expect(refused.webSocket).toBeNull();
    expect((await mum.join(call.callId)).status).toBe(404);

    const a = await alex.events(call.callId);
    await a.next("roster");
    a.send({ type: "keys", epoch: 2, envelopes: [{ toAccount: mum.accountId, toDevice: 3, blob: blob(10) }] });
    expect(await a.next("error")).toMatchObject({ code: "not_participant" });
    a.close();
  });

  it("answers ping with pong", async () => {
    const dad = await phone(issuer, uniqueAccount());
    const { call } = await dad.create();
    const a = await dad.events(call.callId);
    a.ws.send(JSON.stringify({ type: "ping" }));
    await a.next("pong");
    a.close();
  });
});

describe("Realtime proxy", () => {
  const sdp = { type: "offer", sdp: "v=0 fake offer" };

  async function session(p: Phone, callId: string): Promise<string> {
    const res = await p.request("POST", `/v1/calls/${callId}/sessions`, { sessionDescription: sdp });
    expect(res.status).toBe(201);
    return (await res.json<{ sessionId: string }>()).sessionId;
  }

  it("creates the participant's SFU session with the app secret, which never reaches the phone", async () => {
    const { dad, callId } = await twoPhoneCall();
    const res = await dad.request("POST", `/v1/calls/${callId}/sessions`, { sessionDescription: sdp });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain("test-app-secret");
    const sent = realtime.requests.find((r) => r.path.endsWith("/sessions/new"));
    expect(sent).toMatchObject({
      method: "POST",
      path: "/apps/test-app-id/sessions/new",
      auth: "Bearer test-app-secret",
      body: { sessionDescription: sdp },
    });
    const view = await (await dad.request("GET", `/v1/calls/${callId}`)).json<CallView>();
    expect(view.participants[0]?.sessionId).toBe((JSON.parse(text) as { sessionId: string }).sessionId);
  });

  it("publishes local tracks into the roster, and lets the others subscribe to them", async () => {
    const { dad, mum, callId } = await twoPhoneCall();
    const dadSession = await session(dad, callId);
    const pub = await dad.request("POST", `/v1/calls/${callId}/sessions/${dadSession}/tracks/new`, {
      sessionDescription: sdp,
      tracks: [{ location: "local", mid: "0", trackName: "audio-dad" }],
    });
    expect(pub.status).toBe(200);
    expect(await pub.json()).toMatchObject({ tracks: [{ mid: "0", trackName: "audio-dad" }] });
    const view = await (await mum.request("GET", `/v1/calls/${callId}`)).json<CallView>();
    expect(view.participants[0]?.tracks).toEqual(["audio-dad"]);

    const mumSession = await session(mum, callId);
    const sub = await mum.request("POST", `/v1/calls/${callId}/sessions/${mumSession}/tracks/new`, {
      tracks: [{ location: "remote", sessionId: dadSession, trackName: "audio-dad" }],
    });
    expect(sub.status).toBe(200);
  });

  it("refuses someone else's session (403), and remote tracks that aren't published in this call", async () => {
    const { dad, mum, callId } = await twoPhoneCall();
    const dadSession = await session(dad, callId);
    const mumSession = await session(mum, callId);
    for (const [method, path, body] of [
      ["POST", `/sessions/${dadSession}/tracks/new`, { tracks: [{ location: "local", trackName: "x" }] }],
      ["PUT", `/sessions/${dadSession}/renegotiate`, { sessionDescription: { type: "answer", sdp: "v=0" } }],
      ["PUT", `/sessions/${dadSession}/tracks/close`, { tracks: [{ mid: "0" }], force: true }],
    ] as const) {
      const res = await mum.request(method, `/v1/calls/${callId}${path}`, body);
      expect(res.status, path).toBe(403);
      expect(await errorCode(res)).toBe("not_your_session");
    }
    const notPublished = await mum.request("POST", `/v1/calls/${callId}/sessions/${mumSession}/tracks/new`, {
      tracks: [{ location: "remote", sessionId: dadSession, trackName: "never-published" }],
    });
    expect(notPublished.status).toBe(403);
    expect(await errorCode(notPublished)).toBe("track_not_in_call");
    const forged = await mum.request("POST", `/v1/calls/${callId}/sessions/${mumSession}/tracks/new`, {
      tracks: [{ location: "remote", sessionId: "f".repeat(32), trackName: "audio-dad" }],
    });
    expect(forged.status).toBe(403);
    const proxied = realtime.requests.filter((r) => r.path.includes(dadSession) && !r.path.endsWith("/new"));
    expect(proxied).toEqual([]);
  });

  it("only participants get a session; bad bodies → 400", async () => {
    const dad = await phone(issuer, uniqueAccount());
    const mum = await phone(issuer, uniqueAccount());
    const { call } = await dad.create();
    const res = await mum.request("POST", `/v1/calls/${call.callId}/sessions`, {});
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("not_participant");
    const s = await session(dad, call.callId);
    for (const body of [
      { tracks: [] },
      { tracks: [{ location: "local", trackName: "bad name!" }] },
      {
        tracks: [
          { location: "local", trackName: "a" },
          { location: "remote", sessionId: s, trackName: "b" },
        ],
      },
      { autoDiscover: true },
      { sessionDescription: { type: "pranswer", sdp: "x" }, tracks: [{ location: "local", trackName: "a" }] },
    ]) {
      const bad = await dad.request("POST", `/v1/calls/${call.callId}/sessions/${s}/tracks/new`, body);
      expect(bad.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("renegotiate and close go through for the owner", async () => {
    const { dad, callId } = await twoPhoneCall();
    const s = await session(dad, callId);
    const re = await dad.request("PUT", `/v1/calls/${callId}/sessions/${s}/renegotiate`, {
      sessionDescription: { type: "answer", sdp: "v=0" },
    });
    expect(re.status).toBe(200);
    const close = await dad.request("PUT", `/v1/calls/${callId}/sessions/${s}/tracks/close`, {
      tracks: [{ mid: "0" }],
      force: true,
    });
    expect(close.status).toBe(200);
    expect(realtime.requests.map((r) => `${r.method} ${r.path.replace(s, "S")}`)).toEqual(
      expect.arrayContaining([
        "PUT /apps/test-app-id/sessions/S/renegotiate",
        "PUT /apps/test-app-id/sessions/S/tracks/close",
      ]),
    );
  });

  it("Realtime refusing → 400 realtime_rejected; Realtime down or rate limiting → 502 realtime_unavailable", async () => {
    const { dad, callId } = await twoPhoneCall();
    realtime.failNext = 400;
    const rejected = await dad.request("POST", `/v1/calls/${callId}/sessions`, {});
    expect(rejected.status).toBe(400);
    expect(await errorCode(rejected)).toBe("realtime_rejected");
    realtime.failNext = 503;
    const down = await dad.request("POST", `/v1/calls/${callId}/sessions`, {});
    expect(down.status).toBe(502);
    expect(await errorCode(down)).toBe("realtime_unavailable");
    // A rate limit is "try again later", not a refusal of the phone's request.
    realtime.failNext = 429;
    const limited = await dad.request("POST", `/v1/calls/${callId}/sessions`, {});
    expect(limited.status).toBe(502);
    expect(await errorCode(limited)).toBe("realtime_unavailable");
  });
});
