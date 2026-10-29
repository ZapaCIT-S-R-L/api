// APNs content-free wake-ups for iPhones (the chat service). The request is a background push with no content, names
// or ids: `{"aps":{"content-available":1}}`. The app wakes, fetches its envelopes and decrypts them on the phone.
// The JWT and HTTP/2 logic follows services/calls/src/push.ts (the VoIP ring); the two services keep their own copy.
import type { PushProvider, PushTarget } from "./push";

// Worker secrets (never vars, never logged). All three must be set, or wake-ups stay off.
export interface ApnsEnv {
  // The .p8 key from the Apple developer account (PKCS8 PEM).
  APNS_AUTH_KEY?: string | undefined;
  APNS_KEY_ID?: string | undefined;
  APNS_TEAM_ID?: string | undefined;
  // The app's bundle id (the apns-topic). Defaults to ro.zapakid.app.
  APNS_TOPIC?: string | undefined;
  // "sandbox" for development builds; anything else is production.
  APNS_ENVIRONMENT?: string | undefined;
}

const DEFAULT_TOPIC = "ro.zapakid.app";
// APNs accepts a provider token for an hour and refuses one renewed more than every 20 minutes.
const JWT_TTL_MS = 40 * 60 * 1000;
const SEND_TIMEOUT_MS = 5000;
const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/i;
const WAKE_BODY = JSON.stringify({ aps: { "content-available": 1 } });

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

async function providerToken(key: string, keyId: string, teamId: string): Promise<string> {
  const id = `${keyId}:${teamId}:${key}`;
  const now = Date.now();
  if (jwtCache?.config === id && now - jwtCache.issuedAt < JWT_TTL_MS) return jwtCache.jwt;
  const jwt = await signJwt(key, keyId, teamId, now);
  jwtCache = { config: id, jwt, issuedAt: now };
  return jwt;
}

// Wake-ups to the iPhones among the targets (FCM targets are skipped: Android is not here yet). Never throws: a failed
// push is logged (status and APNs reason, never the device token, the key or the JWT) and the message goes on.
export function apnsProvider(config: ApnsEnv): PushProvider {
  const key = config.APNS_AUTH_KEY;
  const keyId = config.APNS_KEY_ID?.trim();
  const teamId = config.APNS_TEAM_ID?.trim();
  const topic = config.APNS_TOPIC?.trim() || DEFAULT_TOPIC;
  const host = config.APNS_ENVIRONMENT === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";

  async function send(token: string, jwt: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`https://${host}/3/device/${token}`, {
        method: "POST",
        headers: {
          authorization: `bearer ${jwt}`,
          "apns-push-type": "background",
          "apns-topic": topic,
          "apns-priority": "5",
          "content-type": "application/json",
        },
        body: WAKE_BODY,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (e) {
      console.warn(`apns wake failed: ${e instanceof Error ? e.name : "error"}`);
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
    console.warn(`apns wake failed: ${res.status} ${reason}`);
  }

  return {
    async wake(targets: PushTarget[]) {
      const tokens = targets.flatMap((t) => (t.provider === "apns" ? [t.token] : []));
      if (tokens.length === 0) return;
      if (!key || !keyId || !teamId) return;
      let jwt: string;
      try {
        jwt = await providerToken(key, keyId, teamId);
      } catch (e) {
        console.error(
          e instanceof ApnsKeyError ? "apns: APNS_AUTH_KEY is not a PKCS8 P-256 key" : "apns: signing failed",
        );
        return;
      }
      const valid = tokens.filter((t) => DEVICE_TOKEN.test(t));
      if (valid.length < tokens.length) console.warn(`apns: ${tokens.length - valid.length} malformed device token(s)`);
      await Promise.all(valid.map((token) => send(token, jwt)));
    },
  };
}

// True when the three secrets are all set. Without them nothing is sent (tests, local dev, environments without APNs).
export function apnsConfigured(config: ApnsEnv): boolean {
  return Boolean(config.APNS_AUTH_KEY && config.APNS_KEY_ID?.trim() && config.APNS_TEAM_ID?.trim());
}

// APNs when configured; otherwise a provider that sends nothing.
export function providerFor(config: ApnsEnv): PushProvider {
  return apnsConfigured(config) ? apnsProvider(config) : { wake: () => Promise.resolve() };
}
