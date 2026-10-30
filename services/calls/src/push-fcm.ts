// Ringing Android phones: one high-priority FCM data message per device, which the app turns into a full-screen
// incoming call. Pushes carry ids only — the name on the ringing screen comes from the phone's own conversations,
// never from the push. The Android app fixes the shape (ro.zapakid.calls.ring.CallPush): type "call" with callId and
// conversationId, or type "call_cancel" with callId.
//
// FCM's v1 API takes an OAuth 2.0 access token minted from a service-account key, the same JWT bearer grant
// src/play-integrity.ts uses in the accounts Worker. The credential is the FCM_CREDENTIALS_JSON secret, so without it
// the provider sends nothing (android #57). Registering it is the composite in src/push.ts.
import { importPKCS8, SignJWT } from "jose";
import type { PushProvider, RingingCall } from "./push";

const SEND_URL = "https://fcm.googleapis.com/v1/projects";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const SEND_TIMEOUT_MS = 5000;
// Google's access tokens live an hour; mint a fresh one a minute early.
const RENEW_MARGIN_MS = 60_000;
// A registration token is opaque: printable ASCII, bounded as the device directory stores it.
const DEVICE_TOKEN = /^[\x21-\x7e]{1,4096}$/;
// FCM's error `status` is an enum name; anything else stays out of the logs.
const ERROR_STATUS = /^[A-Z_]{1,64}$/;
// High priority is what wakes the app for the full-screen call, and ttl 0 drops a ring that is already too late.
const ANDROID = { priority: "high", ttl: "0s" };

export interface FcmEnv {
  // The Firebase service-account JSON: project_id, client_email and private_key (PKCS8 PEM).
  FCM_CREDENTIALS_JSON?: string | undefined;
}

interface Credentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

let cached: { email: string; token: string; expiresAt: number } | null = null;

// Tests only: forget the cached access token.
export function resetFcmToken(): void {
  cached = null;
}

export function parseCredentials(raw: string | undefined): Credentials | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { project_id?: unknown; client_email?: unknown; private_key?: unknown };
    const { project_id: projectId, client_email: clientEmail, private_key: privateKey } = value;
    if (typeof projectId !== "string" || !projectId) return null;
    if (typeof clientEmail !== "string" || !clientEmail) return null;
    if (typeof privateKey !== "string" || !privateKey) return null;
    return { projectId, clientEmail, privateKey };
  } catch {
    return null;
  }
}

async function accessToken(credentials: Credentials): Promise<string | null> {
  if (cached && cached.email === credentials.clientEmail && cached.expiresAt > Date.now() + RENEW_MARGIN_MS) {
    return cached.token;
  }
  let assertion: string;
  try {
    const key = await importPKCS8(credentials.privateKey, "RS256");
    assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(credentials.clientEmail)
      .setAudience(TOKEN_URL)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(key);
  } catch {
    console.error("fcm: FCM_CREDENTIALS_JSON is not a usable service-account key");
    return null;
  }
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (e) {
    console.warn(`fcm token failed: ${e instanceof Error ? e.name : "error"}`);
    return null;
  }
  if (!res.ok) {
    console.error(`fcm: the OAuth token endpoint answered ${res.status}`);
    return null;
  }
  let body: { access_token?: unknown; expires_in?: unknown };
  try {
    body = await res.json<{ access_token?: unknown; expires_in?: unknown }>();
  } catch {
    console.error("fcm: the OAuth token endpoint sent no JSON");
    return null;
  }
  if (typeof body.access_token !== "string") {
    console.error("fcm: the OAuth token endpoint sent no access token");
    return null;
  }
  const lifetime = typeof body.expires_in === "number" ? body.expires_in : 3600;
  cached = { email: credentials.clientEmail, token: body.access_token, expiresAt: Date.now() + lifetime * 1000 };
  return body.access_token;
}

// One data message to one phone. Never throws: a failed push is logged (status and FCM reason, never the
// registration token, the key or the access token) and the call goes on.
async function send(
  credentials: Credentials,
  auth: string,
  token: string,
  data: Record<string, string>,
  callId: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${SEND_URL}/${credentials.projectId}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ message: { token, data, android: ANDROID } }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (e) {
    console.warn(`fcm ring failed: ${e instanceof Error ? e.name : "error"} (call ${callId})`);
    return;
  }
  if (res.ok) return;
  let status = "unknown";
  try {
    const body = await res.json<{ error?: { status?: unknown } }>();
    if (typeof body.error?.status === "string" && ERROR_STATUS.test(body.error.status)) status = body.error.status;
  } catch {
    // No JSON body.
  }
  // A refused access token is worth one fresh mint on the next ring.
  if (res.status === 401 || res.status === 403) cached = null;
  console.warn(`fcm ring failed: ${res.status} ${status} (call ${callId})`);
}

export function fcmProvider(config: FcmEnv): PushProvider {
  async function deliver(call: RingingCall, data: Record<string, string>): Promise<void> {
    // One push per token: a phone listed on two device rows must not ring twice, nor be told to stop twice.
    const tokens = [
      ...new Set(
        call.to.flatMap((t) => (t.push?.provider === "fcm" && DEVICE_TOKEN.test(t.push.token) ? [t.push.token] : [])),
      ),
    ];
    if (tokens.length === 0) return;
    const credentials = parseCredentials(config.FCM_CREDENTIALS_JSON);
    if (!credentials) {
      console.error("fcm not configured: FCM_CREDENTIALS_JSON missing or invalid");
      return;
    }
    const auth = await accessToken(credentials);
    if (!auth) return;
    await Promise.all(tokens.map((token) => send(credentials, auth, token, data, call.callId)));
  }

  return {
    ring: (call) => deliver(call, { type: "call", callId: call.callId, conversationId: call.conversationId }),
    // Android does get a cancel, unlike APNs: CallPush stops the ringing phone on type "call_cancel".
    cancel: (call) => deliver(call, { type: "call_cancel", callId: call.callId }),
  };
}
