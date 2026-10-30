// Content-free "new message" alerts for iPhones without an open stream. A push never carries content, names or ids:
// the alert says only that something is waiting (a localized text the app owns), and the app fetches its envelopes
// and decrypts them on the phone when it opens. APNs (iOS) only for now; Android (FCM) comes with its credentials.
// The provider is APNs when the APNS_AUTH_KEY secret is set, and nothing is sent otherwise (tests, local dev).
import type { Env } from "./env";

export interface PushTarget {
  accountId: string;
  deviceId: number;
  provider: "apns" | "fcm";
  token: string;
}

export interface PushProvider {
  wake(targets: PushTarget[]): Promise<void>;
}

export const pushDisabled: PushProvider = { wake: () => Promise.resolve() };

let override: PushProvider | null = null;

// Tests swap in a recording provider; null restores the default.
export function usePushProvider(provider: PushProvider | null): void {
  override = provider;
}

export function pushProvider(env: Env): PushProvider {
  if (override) return override;
  return env.APNS_AUTH_KEY ? apnsAlertProvider(env) : pushDisabled;
}

// The alert's text is localized by the app (this key lives in its Localizable catalogue).
const ALERT_LOC_KEY = "chat.notification.new_message";
const SEND_TIMEOUT_MS = 5000;
// An alert for a phone that is briefly offline is still useful for an hour; a message waits on the server anyway.
const EXPIRY_SECONDS = 60 * 60;
const JWT_TTL_MS = 40 * 60 * 1000;
const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/i;

// APNs settings (wrangler.jsonc vars, per environment) and the auth key (a Worker secret: never a var, never logged).
export interface ApnsEnv {
  APNS_AUTH_KEY?: string | undefined;
  APNS_KEY_ID?: string | undefined;
  APNS_TEAM_ID?: string | undefined;
  APNS_TOPIC?: string | undefined;
  APNS_ENVIRONMENT?: string | undefined;
}

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

// APNs alert pushes to the iPhones among the targets. Never throws: a failed alert is logged (status and APNs reason,
// never the device token, the key or the JWT) and the message waits on the server as before.
export function apnsAlertProvider(config: ApnsEnv): PushProvider {
  const host = config.APNS_ENVIRONMENT === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  const body = JSON.stringify({ aps: { alert: { "loc-key": ALERT_LOC_KEY }, sound: "default" } });

  async function send(token: string, jwt: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`https://${host}/3/device/${token}`, {
        method: "POST",
        headers: {
          authorization: `bearer ${jwt}`,
          "apns-push-type": "alert",
          "apns-topic": config.APNS_TOPIC ?? "",
          "apns-priority": "10",
          "apns-expiration": String(Math.floor(Date.now() / 1000) + EXPIRY_SECONDS),
          "content-type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (e) {
      console.warn(`apns alert failed: ${e instanceof Error ? e.name : "error"}`);
      return;
    }
    if (res.ok) return;
    let reason = "unknown";
    try {
      const data = await res.json<{ reason?: unknown }>();
      if (typeof data.reason === "string" && /^[A-Za-z]{1,64}$/.test(data.reason)) reason = data.reason;
    } catch {
      // No JSON body.
    }
    if (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken") jwtCache = null;
    console.warn(`apns alert failed: ${res.status} ${reason}`);
  }

  return {
    async wake(targets) {
      const tokens = targets.flatMap((t) => (t.provider === "apns" ? [t.token] : []));
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
      await Promise.all(valid.map((token) => send(token, jwt)));
    },
  };
}

// Alert targets (the iPhones' standard APNs tokens) of these devices, for the ones that have one.
export async function pushTargets(env: Env, devices: { accountId: string; deviceId: number }[]): Promise<PushTarget[]> {
  if (devices.length === 0) return [];
  const rows = await env.DB.prepare(
    `SELECT d.account_id, d.device_id, d.alert_push_token
     FROM devices d JOIN json_each(?1) j ON d.account_id = json_extract(j.value, '$.accountId')
       AND d.device_id = json_extract(j.value, '$.deviceId')
     WHERE d.alert_push_token IS NOT NULL`,
  )
    .bind(JSON.stringify(devices))
    .all<{ account_id: string; device_id: number; alert_push_token: string }>();
  return rows.results.map((r) => ({
    accountId: r.account_id,
    deviceId: r.device_id,
    provider: "apns",
    token: r.alert_push_token,
  }));
}
