// Ringing iPhones: APNs VoIP pushes (src/push.ts). A fetch stub records the requests; the APNs key is generated per
// test run, never a real one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apnsProvider, providerFor, resetApnsToken, type RingingCall } from "../../src/push";

interface Sent {
  url: string;
  headers: Headers;
  body: string;
}

let sent: Sent[];
let answer: () => Response | Promise<Response>;
let pem: string;
let publicKey: CryptoKey;
let logged: string[];

const DEVICE_A = "a".repeat(64);
const DEVICE_B = "0123456789abcdef".repeat(4);

// PEM armour, assembled at run time so the secret scanner doesn't take the test for a committed key.
const LABEL = ["PRIVATE", "KEY"].join(" ");
const armour = (body: string) => [`-----BEGIN ${LABEL}-----`, body, `-----END ${LABEL}-----`, ""].join("\n");

async function makeKey(): Promise<void> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  publicKey = pair.publicKey;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der));
  pem = armour(b64.replace(/.{64}(?!$)/g, "$&\n"));
}

const config = () => ({
  APNS_AUTH_KEY: pem,
  APNS_KEY_ID: "KEYID12345",
  APNS_TEAM_ID: "TEAMID1234",
  APNS_TOPIC: "ro.zapakid.app",
});

const call = (to: RingingCall["to"]): RingingCall => ({
  callId: "call-1",
  conversationId: "conv-1",
  from: "acc-0",
  to,
});

const iphone = (accountId: string, deviceId: number, token: string) => ({
  accountId,
  deviceId,
  push: { provider: "apns" as const, token },
});

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
  resetApnsToken();
  sent = [];
  logged = [];
  answer = () => new Response(null, { status: 200 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push({ url: request.url, headers: request.headers, body: await request.text() });
    return answer();
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

describe("APNs VoIP ring", () => {
  it("sends one VoIP push per iOS device: topic <bundle id>.voip, priority 10, a JWT, only the call id", async () => {
    await apnsProvider(config()).ring(call([iphone("acc-1", 1, DEVICE_A), iphone("acc-2", 3, DEVICE_B)]));

    expect(sent.map((s) => s.url).sort()).toEqual([
      `https://api.push.apple.com/3/device/${DEVICE_B}`,
      `https://api.push.apple.com/3/device/${DEVICE_A}`,
    ]);
    for (const s of sent) {
      expect(s.headers.get("apns-push-type")).toBe("voip");
      expect(s.headers.get("apns-topic")).toBe("ro.zapakid.app.voip");
      expect(s.headers.get("apns-priority")).toBe("10");
      expect(s.headers.get("apns-expiration")).toBe("0");
      expect(JSON.parse(s.body)).toEqual({ callId: "call-1" });
      expect(s.body).not.toContain("acc-0");
      expect(s.body).not.toContain("conv-1");
    }
  });

  it("authorizes with an ES256 JWT: kid = APNS_KEY_ID, iss = APNS_TEAM_ID, iat now, signed with the key", async () => {
    await apnsProvider(config()).ring(call([iphone("acc-1", 1, DEVICE_A)]));

    const [scheme, jwt] = (sent[0]?.headers.get("authorization") ?? "").split(" ");
    expect(scheme).toBe("bearer");
    const [h = "", p = "", sig = ""] = (jwt ?? "").split(".");
    expect(decode(h)).toEqual({ alg: "ES256", kid: "KEYID12345" });
    const claims = decode(p);
    expect(claims.iss).toBe("TEAMID1234");
    expect(Math.abs((claims.iat as number) - Date.now() / 1000)).toBeLessThan(5);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      bytes(sig),
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(valid).toBe(true);
  });

  it("reuses the JWT for about 40 minutes, then signs a new one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const apns = apnsProvider(config());
    const auth = () => sent.at(-1)?.headers.get("authorization");
    await apns.ring(call([iphone("acc-1", 1, DEVICE_A)]));
    const first = auth();
    vi.advanceTimersByTime(39 * 60 * 1000);
    await apns.ring(call([iphone("acc-1", 1, DEVICE_A)]));
    expect(auth()).toBe(first);
    vi.advanceTimersByTime(2 * 60 * 1000);
    await apns.ring(call([iphone("acc-1", 1, DEVICE_A)]));
    expect(auth()).not.toBe(first);
  });

  it("uses the sandbox host only when APNS_ENVIRONMENT is sandbox", async () => {
    await apnsProvider({ ...config(), APNS_ENVIRONMENT: "sandbox" }).ring(call([iphone("acc-1", 1, DEVICE_A)]));
    await apnsProvider({ ...config(), APNS_ENVIRONMENT: "production" }).ring(call([iphone("acc-1", 1, DEVICE_A)]));
    await apnsProvider({ ...config(), APNS_ENVIRONMENT: "anything" }).ring(call([iphone("acc-1", 1, DEVICE_A)]));
    expect(sent.map((s) => new URL(s.url).host)).toEqual([
      "api.sandbox.push.apple.com",
      "api.push.apple.com",
      "api.push.apple.com",
    ]);
  });

  it("sends nothing to Android (fcm) devices or devices without a push token", async () => {
    await apnsProvider(config()).ring(
      call([
        { accountId: "acc-1", deviceId: 1, push: { provider: "fcm", token: "fcm-token" } },
        { accountId: "acc-2", deviceId: 2 },
        iphone("acc-3", 1, DEVICE_A),
      ]),
    );
    expect(sent.map((s) => s.url)).toEqual([`https://api.push.apple.com/3/device/${DEVICE_A}`]);
  });

  it("skips a malformed token instead of putting it in the URL", async () => {
    await apnsProvider(config()).ring(call([iphone("acc-1", 1, "../../x?y"), iphone("acc-2", 1, DEVICE_A)]));
    expect(sent.map((s) => s.url)).toEqual([`https://api.push.apple.com/3/device/${DEVICE_A}`]);
  });

  it("rings a token once, even when two devices list it (a phone that registered twice)", async () => {
    await apnsProvider(config()).ring(call([iphone("acc-1", 1, DEVICE_A), iphone("acc-1", 2, DEVICE_A)]));
    expect(sent.map((s) => s.url)).toEqual([`https://api.push.apple.com/3/device/${DEVICE_A}`]);
  });

  it("cancel sends nothing (the ringing phone learns from the events WebSocket)", async () => {
    await apnsProvider(config()).cancel(call([iphone("acc-1", 1, DEVICE_A)]));
    expect(sent).toEqual([]);
  });
});

describe("APNs failures never fail the call", () => {
  it("an APNs error answer or a network error does not throw out of ring, and the other devices still ring", async () => {
    let n = 0;
    answer = () => {
      n++;
      if (n === 1) return Response.json({ reason: "BadDeviceToken" }, { status: 400 });
      if (n === 2) return Promise.reject(new Error("connection reset"));
      return new Response(null, { status: 200 });
    };
    await expect(
      apnsProvider(config()).ring(
        call([iphone("acc-1", 1, DEVICE_A), iphone("acc-2", 1, DEVICE_B), iphone("acc-3", 1, "c".repeat(64))]),
      ),
    ).resolves.toBeUndefined();
    expect(sent).toHaveLength(3);
    expect(logged.some((l) => l.includes("BadDeviceToken"))).toBe(true);
  });

  it("logs neither the device token nor the key", async () => {
    answer = () => Response.json({ reason: "Unregistered" }, { status: 410 });
    await apnsProvider(config()).ring(call([iphone("acc-1", 1, DEVICE_A)]));
    expect(logged.length).toBeGreaterThan(0);
    const body = pem.split("\n")[1] ?? "";
    for (const line of logged) {
      expect(line).not.toContain(DEVICE_A);
      expect(line).not.toContain(body);
      expect(line).not.toContain(sent[0]?.headers.get("authorization")?.split(" ")[1]);
    }
  });

  it("a key that isn't a valid PKCS8 P-256 key: logged by name, nothing sent, no throw", async () => {
    await expect(
      apnsProvider({
        ...config(),
        APNS_AUTH_KEY: armour("bm90IGEga2V5"),
      }).ring(call([iphone("acc-1", 1, DEVICE_A)])),
    ).resolves.toBeUndefined();
    expect(sent).toEqual([]);
    expect(logged.some((l) => l.includes("APNS_AUTH_KEY"))).toBe(true);
    expect(logged.join("\n")).not.toContain("bm90IGEga2V5");
  });

  it("missing APNS_KEY_ID, APNS_TEAM_ID or APNS_TOPIC: names them, sends nothing, no throw", async () => {
    await expect(
      apnsProvider({ APNS_AUTH_KEY: pem, APNS_KEY_ID: "", APNS_TEAM_ID: "", APNS_TOPIC: "" }).ring(
        call([iphone("acc-1", 1, DEVICE_A)]),
      ),
    ).resolves.toBeUndefined();
    expect(sent).toEqual([]);
    expect(logged.join("\n")).toMatch(/APNS_KEY_ID.*APNS_TEAM_ID.*APNS_TOPIC/);
  });

  it("drops the cached JWT when APNs rejects it, so the next ring signs a fresh one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const apns = apnsProvider(config());
    answer = () => Response.json({ reason: "ExpiredProviderToken" }, { status: 403 });
    await apns.ring(call([iphone("acc-1", 1, DEVICE_A)]));
    const first = sent[0]?.headers.get("authorization");
    vi.advanceTimersByTime(1000);
    answer = () => new Response(null, { status: 200 });
    await apns.ring(call([iphone("acc-1", 1, DEVICE_A)]));
    expect(sent[1]?.headers.get("authorization")).not.toBe(first);
  });
});

describe("provider selection", () => {
  it("without APNS_AUTH_KEY the stub stays: nothing is sent", async () => {
    await providerFor({ ...config(), APNS_AUTH_KEY: undefined }).ring(call([iphone("acc-1", 1, DEVICE_A)]));
    expect(sent).toEqual([]);
  });

  it("with APNS_AUTH_KEY set, iPhones ring through APNs", async () => {
    await providerFor(config()).ring(call([iphone("acc-1", 1, DEVICE_A)]));
    expect(sent).toHaveLength(1);
  });
});
