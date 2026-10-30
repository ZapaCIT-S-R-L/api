// Message alerts: APNs alert pushes (src/push.ts). A fetch stub records the requests; the APNs key is generated per
// test run, never a real one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apnsAlertProvider, resetApnsToken, type ApnsEnv, type PushTarget } from "../../src/push";

interface Sent {
  url: string;
  headers: Headers;
  body: string;
}

let sent: Sent[];
let answer: () => Response | Promise<Response>;
let pem: string;
let logged: string[];

const TOKEN = "a".repeat(64);

// PEM armour, assembled at run time so the secret scanner doesn't take the test for a committed key.
const LABEL = ["PRIVATE", "KEY"].join(" ");
const armour = (body: string) => [`-----BEGIN ${LABEL}-----`, body, `-----END ${LABEL}-----`, ""].join("\n");

async function makeKey(): Promise<void> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  pem = armour(btoa(String.fromCharCode(...der)).replace(/.{64}(?!$)/g, "$&\n"));
}

const config = (): ApnsEnv => ({
  APNS_AUTH_KEY: pem,
  APNS_KEY_ID: "KEYID12345",
  APNS_TEAM_ID: "TEAMID1234",
  APNS_TOPIC: "ro.zapakid.app",
  APNS_ENVIRONMENT: "production",
});

const target = (token: string): PushTarget => ({ accountId: "acc-1", deviceId: 1, provider: "apns", token });

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
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("APNs message alerts", () => {
  it("sends an alert push to each iPhone's alert token, with the topic of the app (not its VoIP topic)", async () => {
    await apnsAlertProvider(config()).wake([target(TOKEN), target("b".repeat(64))]);
    expect(sent.map((s) => s.url).sort()).toEqual(
      [`https://api.push.apple.com/3/device/${TOKEN}`, `https://api.push.apple.com/3/device/${"b".repeat(64)}`].sort(),
    );
    for (const s of sent) {
      expect(s.headers.get("apns-push-type")).toBe("alert");
      expect(s.headers.get("apns-topic")).toBe("ro.zapakid.app");
      expect(s.headers.get("apns-priority")).toBe("10");
      expect(s.headers.get("authorization")).toMatch(/^bearer \S+\.\S+\.\S+$/);
    }
  });

  it("the payload is content-free: a localized key and a sound, nothing about the sender or the message", async () => {
    await apnsAlertProvider(config()).wake([target(TOKEN)]);
    expect(JSON.parse(sent[0]?.body ?? "{}")).toEqual({
      aps: { alert: { "loc-key": "chat.notification.new_message" }, sound: "default" },
    });
  });

  it("uses the sandbox host for the staging environment", async () => {
    await apnsAlertProvider({ ...config(), APNS_ENVIRONMENT: "sandbox" }).wake([target(TOKEN)]);
    expect(sent[0]?.url).toBe(`https://api.sandbox.push.apple.com/3/device/${TOKEN}`);
  });

  it("sends nothing to fcm targets (Android has no alert yet)", async () => {
    await apnsAlertProvider(config()).wake([{ ...target(TOKEN), provider: "fcm" }]);
    expect(sent).toEqual([]);
  });

  it("without the key, or without the topic, nothing is sent and the problem is logged", async () => {
    await apnsAlertProvider({ ...config(), APNS_AUTH_KEY: undefined }).wake([target(TOKEN)]);
    await apnsAlertProvider({ ...config(), APNS_TOPIC: "" }).wake([target(TOKEN)]);
    expect(sent).toEqual([]);
    expect(logged.join("\n")).toMatch(/apns not configured: APNS_TOPIC missing/);
  });

  it("a refused push is logged by APNs reason only, never with the token", async () => {
    answer = () => new Response(JSON.stringify({ reason: "BadDeviceToken" }), { status: 400 });
    await apnsAlertProvider(config()).wake([target(TOKEN)]);
    expect(logged).toEqual(["apns alert failed: 400 BadDeviceToken"]);
    expect(logged.join("\n")).not.toContain(TOKEN);
  });

  it("a network failure is logged and does not throw", async () => {
    answer = () => {
      throw new TypeError("network down");
    };
    await expect(apnsAlertProvider(config()).wake([target(TOKEN)])).resolves.toBeUndefined();
    expect(logged).toEqual(["apns alert failed: TypeError"]);
  });
});
