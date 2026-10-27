// The calls flow over HTTP and WebSocket against wrangler dev: two phones start, join and leave a call, exchange a
// sealed key envelope, and set up SFU sessions through the proxy (fake Realtime/TURN, test/e2e/fakes.ts). Against
// a deployed environment (LIVE=1) only the checks that need no valid chat token run.
import { importJWK, SignJWT, type JWTPayload } from "jose";
import { describe, expect, inject, it } from "vitest";
import { calls, CALLS_URL, LIVE } from "./base";

const AUDIENCE = "calls.localhost";
const ISSUER = "http://localhost:8787";
const run = Date.now().toString(36);

async function token(claims: JWTPayload, ttl = 600): Promise<string> {
  const jwk = inject("issuerKey");
  const key = await importJWK(jwk, "ES256");
  return new SignJWT({
    iss: ISSUER,
    aud: ["chat.localhost", AUDIENCE],
    role: "parent",
    conv: [`conv-${run}`],
    ...claims,
  })
    .setProtectedHeader({ alg: "ES256", kid: jwk.kid ?? "", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .sign(key);
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (path: string, t: string, body?: unknown) =>
  calls(path, {
    method: "POST",
    headers: { ...auth(t), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

interface Socket {
  ws: WebSocket;
  next(type: string): Promise<Record<string, unknown>>;
}

function connect(callId: string, t: string): Promise<Socket> {
  const ws = new WebSocket(`${CALLS_URL.replace(/^http/, "ws")}/v1/calls/${callId}/events`, {
    headers: auth(t),
  } as unknown as string[]);
  const messages: Record<string, unknown>[] = [];
  let read = 0;
  ws.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data)) as Record<string, unknown>));
  const next = async (type: string) => {
    for (let waited = 0; waited < 5000; waited += 25) {
      const i = messages.findIndex((m, j) => j >= read && m.type === type);
      if (i >= 0) {
        read = i + 1;
        return messages[i] as Record<string, unknown>;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no ${type}; got ${JSON.stringify(messages.slice(read))}`);
  };
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      resolve({ ws, next });
    });
    ws.addEventListener("error", () => {
      reject(new Error("WebSocket failed"));
    });
  });
}

describe("calls without a valid chat token", () => {
  it("POST /v1/calls without a token → 401", async () => {
    const res = await calls("/v1/calls", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("a token signed by a key the account API doesn't have → 401", async () => {
    const { generateKeyPair } = await import("jose");
    const { privateKey } = await generateKeyPair("ES256");
    const forged = await new SignJWT({ sub: "x", dev: 1, role: "parent", conv: ["c"] })
      .setProtectedHeader({ alg: "ES256", kid: "forged" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const res = await post("/v1/calls", forged, { conversationId: "c" });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(LIVE)("a call between two phones (local, fake Realtime)", () => {
  const conv = `conv-${run}`;

  it("start, ring, join, key relay, SFU sessions, leave", async () => {
    const dad = await token({ sub: `dad-${run}`, dev: 1 });
    const kid = await token({ sub: `kid-${run}`, dev: 2, role: "kid" });

    const created = await post("/v1/calls", dad, { conversationId: conv });
    expect(created.status).toBe(201);
    const { call, iceServers } = (await created.json()) as {
      call: { callId: string; epoch: number };
      iceServers: { username?: string }[];
    };
    expect(iceServers.some((s) => s.username?.startsWith("e2e-"))).toBe(true);

    const a = await connect(call.callId, dad);
    await a.next("roster");

    const joined = await post(`/v1/calls/${call.callId}/join`, kid);
    expect(joined.status).toBe(200);
    expect(await a.next("joined")).toMatchObject({ accountId: `kid-${run}`, deviceId: 2, epoch: 2 });

    const b = await connect(call.callId, kid);
    await b.next("roster");
    a.ws.send(
      JSON.stringify({
        type: "keys",
        epoch: 2,
        envelopes: [{ toAccount: `kid-${run}`, toDevice: 2, blob: "c2VhbGVk" }],
      }),
    );
    expect(await b.next("key")).toMatchObject({ epoch: 2, fromAccount: `dad-${run}`, fromDevice: 1, blob: "c2VhbGVk" });

    const s1 = await post(`/v1/calls/${call.callId}/sessions`, dad, {});
    expect(s1.status).toBe(201);
    const { sessionId } = (await s1.json()) as { sessionId: string };
    const pub = await post(`/v1/calls/${call.callId}/sessions/${sessionId}/tracks/new`, dad, {
      sessionDescription: { type: "offer", sdp: "v=0 e2e offer" },
      tracks: [{ location: "local", mid: "0", trackName: `audio-${run}` }],
    });
    expect(pub.status).toBe(200);
    const theirs = await post(`/v1/calls/${call.callId}/sessions/${sessionId}/tracks/new`, kid, {
      tracks: [{ location: "local", trackName: "hijack" }],
    });
    expect(theirs.status).toBe(403);

    expect((await post(`/v1/calls/${call.callId}/leave`, kid)).status).toBe(204);
    expect(await a.next("left")).toMatchObject({ accountId: `kid-${run}`, epoch: 3 });
    expect((await post(`/v1/calls/${call.callId}/leave`, dad)).status).toBe(204);
    expect(await a.next("ended")).toMatchObject({ reason: "hung_up" });
    a.ws.close();
    b.ws.close();
  });

  it("refuses a conversation not in the token, an expired token and a token for another audience", async () => {
    const other = await token({ sub: `x-${run}`, dev: 1 });
    expect((await post("/v1/calls", other, { conversationId: "conv-not-mine" })).status).toBe(403);
    const expired = await token({ sub: `x-${run}`, dev: 1, iat: Math.floor(Date.now() / 1000) - 900 }, -120);
    expect((await post("/v1/calls", expired, { conversationId: conv })).status).toBe(401);
    const chatOnly = await token({ sub: `x-${run}`, dev: 1, aud: ["chat.localhost"] });
    expect((await post("/v1/calls", chatOnly, { conversationId: conv })).status).toBe(401);
  });

  it("caps a call at 8 participants", async () => {
    const capConv = `cap-${run}`;
    const caller = await token({ sub: `cap0-${run}`, dev: 1, conv: [capConv] });
    const res = await post("/v1/calls", caller, { conversationId: capConv });
    const { call } = (await res.json()) as { call: { callId: string } };
    for (let i = 1; i <= 7; i++) {
      const t = await token({ sub: `cap${i}-${run}`, dev: 1, conv: [capConv] });
      expect((await post(`/v1/calls/${call.callId}/join`, t)).status).toBe(200);
    }
    const ninth = await token({ sub: `cap8-${run}`, dev: 1, conv: [capConv] });
    expect((await post(`/v1/calls/${call.callId}/join`, ninth)).status).toBe(409);
  });

  it("ends an unanswered call at the ring timeout (3 s on the e2e server)", async () => {
    const ringConv = `ring-${run}`;
    const caller = await token({ sub: `ring-${run}`, dev: 1, conv: [ringConv] });
    const res = await post("/v1/calls", caller, { conversationId: ringConv });
    const { call } = (await res.json()) as { call: { callId: string } };
    const a = await connect(call.callId, caller);
    expect(await a.next("ended")).toMatchObject({ reason: "no_answer" });
    a.ws.close();
  });
});
