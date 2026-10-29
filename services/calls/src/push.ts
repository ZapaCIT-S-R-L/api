// Ringing the other members' phones: PushKit VoIP (iOS, with CallKit) and high-priority FCM data messages (Android,
// with a full-screen incoming call). Pushes carry no content beyond the call id.
//
// iOS: an APNs VoIP push per iPhone (api #102), switched on when the APNS_AUTH_KEY secret is set. The device push
// tokens don't reach this service yet (ChatMembership.member lists device ids only), so a target without `push` is
// not rung; phones also learn about calls from the events WebSocket and the call log. Android (FCM) is not here yet.
import { env } from "cloudflare:workers";

export interface RingTarget {
  accountId: string;
  deviceId: number;
  // Where to push this device, once the chat service hands the tokens over. iOS: the PushKit VoIP token (hex).
  push?: { provider: "apns" | "fcm"; token: string };
}

export interface RingingCall {
  callId: string;
  conversationId: string;
  // The caller's account id.
  from: string;
  // Every device of the other members when the call started (from the chat service); the caller's own are left out.
  to: RingTarget[];
}

export interface PushProvider {
  // Rings every member device of the conversation except the caller's.
  ring(call: RingingCall): Promise<void>;
  // Stops the ringing (answered elsewhere, cancelled, no answer).
  cancel(call: RingingCall): Promise<void>;
}

const noPush: PushProvider = {
  ring: () => Promise.resolve(),
  cancel: () => Promise.resolve(),
};

// APNs settings (wrangler.jsonc vars, per environment) and the auth key (a Worker secret: never a var, never logged).
export interface ApnsEnv {
  // The .p8 key from the Apple developer account (PKCS8 PEM).
  APNS_AUTH_KEY?: string | undefined;
  APNS_KEY_ID?: string | undefined;
  APNS_TEAM_ID?: string | undefined;
  // The app's bundle id; VoIP pushes go to "<bundle id>.voip".
  APNS_TOPIC?: string | undefined;
  // "sandbox" for development builds; anything else is production.
  APNS_ENVIRONMENT?: string | undefined;
}

// APNs accepts a provider token for an hour and refuses one renewed more than every 20 minutes.
const JWT_TTL_MS = 40 * 60 * 1000;
const SEND_TIMEOUT_MS = 5000;
const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/i;

let jwtCache: { config: string; jwt: string; issuedAt: number } | null = null;

// Tests only: forget the cached provider token.
export function resetApnsToken(): void {
  jwtCache = null;
}

const base64url = (data: ArrayBuffer | Uint8Array | string): string => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

class ApnsKeyError extends Error {}

async function signJwt(pem: string, keyId: string, teamId: string, now: number): Promise<string> {
  let key: CryptoKey;
  try {
    const der = Uint8Array.from(atob(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "")), (c) => c.charCodeAt(0));
    key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch {
    throw new ApnsKeyError();
  }
  const input = `${base64url(JSON.stringify({ alg: "ES256", kid: keyId }))}.${base64url(
    JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }),
  )}`;
  // WebCrypto signs ECDSA as r || s, the JWS form.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input));
  return `${input}.${base64url(signature)}`;
}

async function providerToken(config: { APNS_AUTH_KEY: string; APNS_KEY_ID: string; APNS_TEAM_ID: string }) {
  const id = `${config.APNS_KEY_ID}:${config.APNS_TEAM_ID}:${config.APNS_AUTH_KEY}`;
  const now = Date.now();
  if (jwtCache?.config === id && now - jwtCache.issuedAt < JWT_TTL_MS) return jwtCache.jwt;
  const jwt = await signJwt(config.APNS_AUTH_KEY, config.APNS_KEY_ID, config.APNS_TEAM_ID, now);
  jwtCache = { config: id, jwt, issuedAt: now };
  return jwt;
}

// APNs VoIP pushes to the iPhones among the targets. Never throws: a failed push is logged (status and APNs reason,
// never the device token, the key or the JWT) and the call goes on.
export function apnsProvider(config: ApnsEnv): PushProvider {
  const host = config.APNS_ENVIRONMENT === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";

  async function send(callId: string, token: string, jwt: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`https://${host}/3/device/${token}`, {
        method: "POST",
        headers: {
          authorization: `bearer ${jwt}`,
          "apns-push-type": "voip",
          "apns-topic": `${config.APNS_TOPIC}.voip`,
          "apns-priority": "10",
          // A ring is useless later: APNs doesn't store it for an offline phone.
          "apns-expiration": "0",
          "content-type": "application/json",
        },
        body: JSON.stringify({ callId }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (e) {
      console.warn(`apns ring failed: ${e instanceof Error ? e.name : "error"} (call ${callId})`);
      return;
    }
    if (res.ok) return;
    let reason = "unknown";
    try {
      const body = await res.json<{ reason?: unknown }>();
      if (typeof body.reason === "string" && /^[A-Za-z]{1,64}$/.test(body.reason)) reason = body.reason;
    } catch {
      // No JSON body.
    }
    if (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken") jwtCache = null;
    console.warn(`apns ring failed: ${res.status} ${reason} (call ${callId})`);
  }

  return {
    async ring(call) {
      const tokens = call.to.flatMap((t) => (t.push?.provider === "apns" ? [t.push.token] : []));
      if (tokens.length === 0) return;
      const missing = (["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_TOPIC"] as const).filter((name) => !config[name]?.trim());
      if (missing.length > 0 || !config.APNS_AUTH_KEY) {
        console.error(`apns not configured: ${missing.join(", ")} missing`);
        return;
      }
      let jwt: string;
      try {
        jwt = await providerToken({
          APNS_AUTH_KEY: config.APNS_AUTH_KEY,
          APNS_KEY_ID: config.APNS_KEY_ID ?? "",
          APNS_TEAM_ID: config.APNS_TEAM_ID ?? "",
        });
      } catch (e) {
        console.error(
          e instanceof ApnsKeyError ? "apns: APNS_AUTH_KEY is not a PKCS8 P-256 key" : "apns: signing failed",
        );
        return;
      }
      const valid = tokens.filter((t) => DEVICE_TOKEN.test(t));
      if (valid.length < tokens.length) console.warn(`apns: ${tokens.length - valid.length} malformed device token(s)`);
      await Promise.all(valid.map((token) => send(call.callId, token, jwt)));
    },
    // Nothing to send: a VoIP push must always show a new call in CallKit, so it can't stop one. The phone that is
    // ringing has the app running for CallKit and learns the end from the events WebSocket.
    cancel: () => Promise.resolve(),
  };
}

// The provider for this environment: APNs when the APNS_AUTH_KEY secret is set, the stub otherwise (tests, local dev).
export function providerFor(config: ApnsEnv): PushProvider {
  return config.APNS_AUTH_KEY ? apnsProvider(config) : noPush;
}

let override: PushProvider | null = null;

// Tests set the provider; null restores the one for the environment.
export function usePushProvider(replacement: PushProvider | null): void {
  override = replacement;
}

export function pushProvider(): PushProvider {
  return override ?? providerFor(env as ApnsEnv);
}
