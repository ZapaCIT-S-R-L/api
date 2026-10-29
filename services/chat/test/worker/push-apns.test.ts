// Content-free wake-ups over APNs (src/apns.ts). A fetch stub records the requests; the APNs key is generated per test
// run, never a real one. No real network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apnsProvider, providerFor, type ApnsEnv } from "../../src/apns";
import type { PushTarget } from "../../src/push";

interface Sent {
  url: string;
  headers: Headers;
  body: string;
}

let sent: Sent[];
let publicKey: CryptoKey;
let pem: string;
let logged: string[];

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

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
  pem = armour(btoa(String.fromCharCode(...der)).replace(/.{64}(?!$)/g, "$&\n"));
}

const secrets = (): ApnsEnv => ({
  APNS_AUTH_KEY: pem,
  APNS_KEY_ID: "68239BP2QT",
  APNS_TEAM_ID: "TEAMID1234",
});

const target = (token: string, deviceId = 1, provider: "apns" | "fcm" = "apns"): PushTarget => ({
  accountId: "acc-1",
  deviceId,
  provider,
  token,
});

function decode(part: string): Record<string, unknown> {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))) as Record<string, unknown>;
}

beforeEach(async () => {
  await makeKey();
  sent = [];
  logged = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sent.push({ url: String(input), headers, body: String(init?.body) });
      return Promise.resolve(new Response(null, { status: 200 }));
    }),
  );
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logged.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void logged.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a.join(" ")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("APNs wake-up request", () => {
  it("posts a content-free background push to the production host with the required headers", async () => {
    await apnsProvider(secrets()).wake([target(TOKEN_A)]);

    expect(sent).toHaveLength(1);
    const [req] = sent;
    expect(req.url).toBe(`https://api.push.apple.com/3/device/${TOKEN_A}`);
    expect(req.headers.get("apns-push-type")).toBe("background");
    expect(req.headers.get("apns-priority")).toBe("5");
    expect(req.headers.get("apns-topic")).toBe("ro.zapakid.app");
    expect(req.headers.get("authorization")).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(JSON.parse(req.body)).toEqual({ aps: { "content-available": 1 } });
  });

  it("uses the sandbox host when APNS_ENVIRONMENT is sandbox", async () => {
    await apnsProvider({ ...secrets(), APNS_ENVIRONMENT: "sandbox" }).wake([target(TOKEN_A)]);
    expect(sent[0].url).toBe(`https://api.sandbox.push.apple.com/3/device/${TOKEN_A}`);
  });

  it("uses the production host for any other APNS_ENVIRONMENT", async () => {
    await apnsProvider({ ...secrets(), APNS_ENVIRONMENT: "production" }).wake([target(TOKEN_A)]);
    expect(sent[0].url).toBe(`https://api.push.apple.com/3/device/${TOKEN_A}`);
  });

  it("sends one request per iPhone and skips FCM targets", async () => {
    await apnsProvider(secrets()).wake([target(TOKEN_A, 1), target(TOKEN_B, 2), target("c".repeat(64), 3, "fcm")]);
    expect(sent.map((s) => s.url)).toEqual([
      `https://api.push.apple.com/3/device/${TOKEN_A}`,
      `https://api.push.apple.com/3/device/${TOKEN_B}`,
    ]);
  });

  it("signs an ES256 provider token with the key id and team id", async () => {
    await apnsProvider(secrets()).wake([target(TOKEN_A)]);
    const jwt = (sent[0].headers.get("authorization") ?? "").replace(/^bearer /, "");
    const [h, p, s] = jwt.split(".");
    expect(decode(h)).toEqual({ alg: "ES256", kid: "68239BP2QT" });
    expect(decode(p)).toMatchObject({ iss: "TEAMID1234" });
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const sig = Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      sig,
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });

  it("never logs the key or the provider token", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ reason: "BadDeviceToken" }), { status: 400 }));
    await apnsProvider(secrets()).wake([target(TOKEN_A)]);
    const jwt = (sent[0].headers.get("authorization") ?? "").replace(/^bearer /, "");
    const everything = logged.join("\n");
    expect(everything).toContain("BadDeviceToken");
    expect(everything).not.toContain(jwt);
    expect(everything).not.toContain(pem.split("\n")[1]);
    expect(everything).not.toContain(TOKEN_A);
  });
});

describe("when APNs is switched on", () => {
  it("is enabled only with the auth key, key id and team id all present", async () => {
    const full = secrets();
    for (const drop of ["APNS_AUTH_KEY", "APNS_KEY_ID", "APNS_TEAM_ID"] as const) {
      const partial: ApnsEnv = { ...full, [drop]: undefined };
      await providerFor(partial).wake([target(TOKEN_A)]);
    }
    expect(sent).toHaveLength(0);

    await providerFor(full).wake([target(TOKEN_A)]);
    expect(sent).toHaveLength(1);
  });

  it("sends nothing when no secrets are set", async () => {
    await providerFor({}).wake([target(TOKEN_A), target(TOKEN_B, 2)]);
    expect(sent).toHaveLength(0);
  });

  it("sends nothing for an empty target list", async () => {
    await apnsProvider(secrets()).wake([]);
    expect(sent).toHaveLength(0);
  });
});
