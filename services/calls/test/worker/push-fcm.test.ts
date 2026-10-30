// Ringing Android phones: FCM data messages (src/push-fcm.ts). A fetch stub records the requests; the service-account
// key is generated per test run, never a real one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RingingCall } from "../../src/push";
import { fcmProvider, parseCredentials, resetFcmToken } from "../../src/push-fcm";

interface Sent {
  url: string;
  headers: Headers;
  body: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://fcm.googleapis.com/v1/projects/zapakid-test/messages:send";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const ACCESS_TOKEN = "test-access-token";
const SECOND_TOKEN = "second-test-access-token";
const EMAIL = "calls@zapakid-test.iam.gserviceaccount.com";

const DEVICE_A = "android-registration-token-a";
const DEVICE_B = "android-registration-token-b";

let sent: Sent[];
let answer: (url: string) => Response | Promise<Response>;
let pem: string;
let publicKey: CryptoKey;
let logged: string[];

// PEM armour, assembled at run time so the secret scanner doesn't take the test for a committed key.
const LABEL = ["PRIVATE", "KEY"].join(" ");
const armour = (body: string) => [`-----BEGIN ${LABEL}-----`, body, `-----END ${LABEL}-----`, ""].join("\n");

const tokenAnswer = (token: string = ACCESS_TOKEN) => Response.json({ access_token: token, expires_in: 3600 });

async function makeKey(): Promise<void> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  publicKey = pair.publicKey;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  pem = armour(btoa(String.fromCharCode(...der)).replace(/.{64}(?!$)/g, "$&\n"));
}

const config = () => ({
  FCM_CREDENTIALS_JSON: JSON.stringify({
    type: "service_account",
    project_id: "zapakid-test",
    client_email: EMAIL,
    private_key: pem,
  }),
});

const call = (to: RingingCall["to"]): RingingCall => ({
  callId: "call-1",
  conversationId: "conv-1",
  from: "acc-0",
  to,
});

const android = (accountId: string, deviceId: number, token: string) => ({
  accountId,
  deviceId,
  push: { provider: "fcm" as const, token },
});

const sends = () => sent.filter((s) => s.url === SEND_URL);
const grants = () => sent.filter((s) => s.url === TOKEN_URL);

function decode(part: string): Record<string, unknown> {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))) as Record<string, unknown>;
}

const bytes = (part: string) =>
  Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );

beforeEach(async () => {
  await makeKey();
  resetFcmToken();
  sent = [];
  logged = [];
  answer = (url) => (url === TOKEN_URL ? tokenAnswer() : new Response(null, { status: 200 }));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push({ url: request.url, headers: request.headers, body: await request.text() });
    return answer(request.url);
  });
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("FCM ring", () => {
  it("sends one data message per Android device: high priority, no store-and-forward, ids only", async () => {
    await fcmProvider(config()).ring(call([android("acc-1", 1, DEVICE_A), android("acc-2", 3, DEVICE_B)]));

    expect(sends().map((s) => s.url)).toEqual([SEND_URL, SEND_URL]);
    const messages = sends().map((s) => JSON.parse(s.body) as { message: Record<string, unknown> });
    expect(messages.map((m) => m.message.token).sort()).toEqual([DEVICE_A, DEVICE_B]);
    for (const m of messages) {
      expect(m.message.android).toEqual({ priority: "high", ttl: "0s" });
      expect(m.message.notification).toBeUndefined();
    }
    expect(messages[0]?.message.data).toEqual({ type: "call", callId: "call-1", conversationId: "conv-1" });
    for (const s of sends()) {
      expect(s.headers.get("content-type")).toBe("application/json");
      expect(s.body).not.toContain("acc-0");
    }
  });

  it("authorizes with a bearer token minted from the service account", async () => {
    await fcmProvider(config()).ring(call([android("acc-1", 1, DEVICE_A)]));

    const form = new URLSearchParams(grants()[0]?.body ?? "");
    expect(grants()[0]?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h = "", p = "", sig = ""] = (form.get("assertion") ?? "").split(".");
    expect(decode(h)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decode(p);
    expect(claims.iss).toBe(EMAIL);
    expect(claims.aud).toBe(TOKEN_URL);
    expect(claims.scope).toBe(SCOPE);
    const valid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      publicKey,
      bytes(sig),
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(valid).toBe(true);
    expect(sends()[0]?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("reuses the access token until it is near expiry, then mints a new one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fcm = fcmProvider(config());

    await fcm.ring(call([android("acc-1", 1, DEVICE_A)]));
    expect(grants()).toHaveLength(1);
    vi.advanceTimersByTime(30 * 60 * 1000);
    await fcm.ring(call([android("acc-1", 1, DEVICE_A)]));
    expect(grants()).toHaveLength(1);
    vi.advanceTimersByTime(31 * 60 * 1000);
    await fcm.ring(call([android("acc-1", 1, DEVICE_A)]));
    expect(grants()).toHaveLength(2);
  });

  it("cancel sends type call_cancel with only the call id, which stops the phone", async () => {
    await fcmProvider(config()).cancel(call([android("acc-1", 1, DEVICE_A)]));

    expect(JSON.parse(sends()[0]?.body ?? "")).toEqual({
      message: {
        token: DEVICE_A,
        data: { type: "call_cancel", callId: "call-1" },
        android: { priority: "high", ttl: "0s" },
      },
    });
  });

  it("sends nothing to iOS (apns) devices or to devices without a push token", async () => {
    await fcmProvider(config()).ring(
      call([
        { accountId: "acc-1", deviceId: 1, push: { provider: "apns", token: "a".repeat(64) } },
        { accountId: "acc-2", deviceId: 2 },
        android("acc-3", 1, DEVICE_A),
      ]),
    );

    expect(sends()).toHaveLength(1);
    expect(sends()[0]?.body).toContain(DEVICE_A);
  });

  it("rings a token once, even when two device rows list it", async () => {
    await fcmProvider(config()).ring(call([android("acc-1", 1, DEVICE_A), android("acc-1", 2, DEVICE_A)]));

    expect(sends()).toHaveLength(1);
  });

  it("cancels a token once, even when two device rows list it", async () => {
    await fcmProvider(config()).cancel(call([android("acc-1", 1, DEVICE_A), android("acc-1", 2, DEVICE_A)]));

    expect(sends()).toHaveLength(1);
    expect(JSON.parse(sends()[0]?.body ?? "")).toMatchObject({ message: { data: { type: "call_cancel" } } });
  });

  it("skips a registration token that is not printable ASCII", async () => {
    await fcmProvider(config()).ring(
      call([android("acc-1", 1, "line\nbreak"), android("acc-2", 1, "x".repeat(4097)), android("acc-3", 1, DEVICE_A)]),
    );

    expect(sends()).toHaveLength(1);
    expect(sends()[0]?.body).toContain(DEVICE_A);
  });

  it("parseCredentials takes the project, the email and the key, and refuses anything else", () => {
    expect(parseCredentials(config().FCM_CREDENTIALS_JSON)).toEqual({
      projectId: "zapakid-test",
      clientEmail: EMAIL,
      privateKey: pem,
    });
    for (const broken of [undefined, "", "not json", "null", "[]", "{}", JSON.stringify({ project_id: "p" })]) {
      expect(parseCredentials(broken)).toBeNull();
    }
  });
});

describe("FCM failures never fail the call", () => {
  it("an error answer or a network error does not throw, and the others still ring", async () => {
    let n = 0;
    answer = (url) => {
      if (url === TOKEN_URL) return tokenAnswer();
      n++;
      if (n === 1) return Response.json({ error: { status: "UNREGISTERED" } }, { status: 404 });
      if (n === 2) return Promise.reject(new Error("connection reset"));
      return new Response(null, { status: 200 });
    };

    await expect(
      fcmProvider(config()).ring(
        call([android("acc-1", 1, DEVICE_A), android("acc-2", 1, DEVICE_B), android("acc-3", 1, "token-c")]),
      ),
    ).resolves.toBeUndefined();

    expect(sends()).toHaveLength(3);
    expect(logged.some((l) => l.includes("UNREGISTERED"))).toBe(true);
  });

  it("logs neither the registration token nor the key nor the access token", async () => {
    answer = (url) =>
      url === TOKEN_URL
        ? tokenAnswer()
        : Response.json({ error: { status: "UNREGISTERED", message: DEVICE_A } }, { status: 410 });

    await fcmProvider(config()).ring(call([android("acc-1", 1, DEVICE_A)]));

    expect(logged.length).toBeGreaterThan(0);
    const keyBody = pem.split("\n")[1] ?? "";
    for (const line of logged) {
      expect(line).not.toContain(DEVICE_A);
      expect(line).not.toContain(keyBody);
      expect(line).not.toContain(ACCESS_TOKEN);
    }
  });

  it("drops the cached access token when FCM refuses it, so the next ring mints one", async () => {
    const fcm = fcmProvider(config());
    answer = (url) =>
      url === TOKEN_URL ? tokenAnswer() : Response.json({ error: { status: "UNAUTHENTICATED" } }, { status: 401 });
    await fcm.ring(call([android("acc-1", 1, DEVICE_A)]));
    expect(grants()).toHaveLength(1);

    answer = (url) => (url === TOKEN_URL ? tokenAnswer(SECOND_TOKEN) : new Response(null, { status: 200 }));
    await fcm.ring(call([android("acc-1", 1, DEVICE_A)]));

    expect(grants()).toHaveLength(2);
    expect(sends()[1]?.headers.get("authorization")).toBe(`Bearer ${SECOND_TOKEN}`);
  });

  it("missing or invalid credentials: named, nothing sent, no throw", async () => {
    for (const broken of [undefined, "", "not json", JSON.stringify({ project_id: "p" })]) {
      const ring = fcmProvider({ FCM_CREDENTIALS_JSON: broken }).ring(call([android("acc-1", 1, DEVICE_A)]));
      await expect(ring).resolves.toBeUndefined();
    }

    expect(sent).toEqual([]);
    expect(logged.some((l) => l.includes("FCM_CREDENTIALS_JSON"))).toBe(true);
  });

  it("a private key that isn't PKCS8: named, nothing sent, no throw", async () => {
    const broken = JSON.stringify({ project_id: "p", client_email: EMAIL, private_key: armour("bm90IGEga2V5") });
    const ring = fcmProvider({ FCM_CREDENTIALS_JSON: broken }).ring(call([android("acc-1", 1, DEVICE_A)]));

    await expect(ring).resolves.toBeUndefined();

    expect(sends()).toEqual([]);
    expect(logged.some((l) => l.includes("FCM_CREDENTIALS_JSON"))).toBe(true);
    expect(logged.join("\n")).not.toContain("bm90IGEga2V5");
  });
});

describe("provider selection", () => {
  it("without FCM_CREDENTIALS_JSON the provider stays dormant: nothing is sent", async () => {
    await fcmProvider({}).ring(call([android("acc-1", 1, DEVICE_A)]));

    expect(sent).toEqual([]);
  });
});
