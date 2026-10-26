// App attestation on sign-in. Android: a standard Play Integrity token in ZapaKid-Attestation, bound to the request
// (requestHash = SHA-256 hex of the exact body bytes). The server decodes it with Google's decodeIntegrityToken API,
// authenticated as a service account (OAuth 2.0 JWT bearer grant, signed with jose), and checks the verdicts.
// iOS App Attest comes in a later change; until then an iOS request has no valid attestation.
import { importPKCS8, SignJWT } from "jose";
import { sha256Hex } from "./crypto";
import type { Env } from "./env";

export const ATTESTATION_HEADER = "zapakid-attestation";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/playintegrity";
const MAX_AGE_MS = 10 * 60_000;
const MAX_SKEW_MS = 60_000;
const TIMEOUT_MS = 5000;

export class AttestationFailed extends Error {}
export class AttestationUnavailable extends Error {}

interface Credentials {
  client_email: string;
  private_key: string;
}

let accessToken: { email: string; token: string; expiresAt: number } | null = null;

export function resetPlayIntegrityCache(): void {
  accessToken = null;
}

export function parseCredentials(raw: string | undefined): Credentials | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Credentials>;
    if (typeof value.client_email !== "string" || typeof value.private_key !== "string") return null;
    return { client_email: value.client_email, private_key: value.private_key };
  } catch {
    return null;
  }
}

async function getAccessToken(credentials: Credentials): Promise<string> {
  if (accessToken && accessToken.email === credentials.client_email && accessToken.expiresAt > Date.now() + 60_000) {
    return accessToken.token;
  }
  let assertion: string;
  try {
    const key = await importPKCS8(credentials.private_key, "RS256");
    assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(credentials.client_email)
      .setAudience(TOKEN_URL)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(key);
  } catch {
    throw new AttestationUnavailable("service account key unusable");
  }
  const res = await fetchOrUnavailable(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  if (!res.ok) throw new AttestationUnavailable(`OAuth token endpoint answered ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string") throw new AttestationUnavailable("no access token");
  const lifetime = typeof body.expires_in === "number" ? body.expires_in : 3600;
  accessToken = { email: credentials.client_email, token: body.access_token, expiresAt: Date.now() + lifetime * 1000 };
  return body.access_token;
}

async function fetchOrUnavailable(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new AttestationUnavailable(`fetch failed: ${String(e)}`);
  }
}

interface Verdict {
  requestDetails?: { requestPackageName?: unknown; requestHash?: unknown; timestampMillis?: unknown };
  appIntegrity?: { appRecognitionVerdict?: unknown; packageName?: unknown; certificateSha256Digest?: unknown };
  deviceIntegrity?: { deviceRecognitionVerdict?: unknown };
  accountDetails?: { appLicensingVerdict?: unknown };
}

async function decode(token: string, env: Env, credentials: Credentials): Promise<Verdict> {
  const url = `https://playintegrity.googleapis.com/v1/${encodeURIComponent(env.PLAY_PACKAGE_NAME)}:decodeIntegrityToken`;
  const res = await fetchOrUnavailable(url, {
    method: "POST",
    headers: { authorization: `Bearer ${await getAccessToken(credentials)}`, "content-type": "application/json" },
    body: JSON.stringify({ integrity_token: token }),
  });
  // 400: Google can't decode it (forged, for another app, malformed).
  if (res.status === 400) throw new AttestationFailed("token not decodable");
  if (!res.ok) throw new AttestationUnavailable(`decodeIntegrityToken answered ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { tokenPayloadExternal?: Verdict };
  if (!body.tokenPayloadExternal) throw new AttestationUnavailable("no verdict in the answer");
  return body.tokenPayloadExternal;
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

// Every check must pass; the first failing one is the reason (logged, not returned to the client).
function check(verdict: Verdict, requestHash: string, env: Env): void {
  const fail = (reason: string) => {
    throw new AttestationFailed(reason);
  };
  const request = verdict.requestDetails ?? {};
  if (request.requestPackageName !== env.PLAY_PACKAGE_NAME) fail("request package");
  if (request.requestHash !== requestHash) fail("request hash");
  const at = Number(request.timestampMillis);
  if (!Number.isFinite(at) || at < Date.now() - MAX_AGE_MS || at > Date.now() + MAX_SKEW_MS) fail("timestamp");
  const app = verdict.appIntegrity ?? {};
  if (app.appRecognitionVerdict !== "PLAY_RECOGNIZED") fail("app not recognized");
  if (app.packageName !== env.PLAY_PACKAGE_NAME) fail("app package");
  const certs = Array.isArray(app.certificateSha256Digest) ? app.certificateSha256Digest : [];
  const allowed = list(env.PLAY_CERT_SHA256);
  if (allowed.length === 0 || !certs.some((c) => typeof c === "string" && allowed.includes(c))) fail("certificate");
  const device = verdict.deviceIntegrity?.deviceRecognitionVerdict;
  if (!Array.isArray(device) || !device.includes("MEETS_DEVICE_INTEGRITY")) fail("device integrity");
  if (verdict.accountDetails?.appLicensingVerdict !== "LICENSED") fail("licensing");
}

// Policies (ATTESTATION_POLICY): "required" (production: no header → refused), "allowlist" (staging: no header
// only for accounts in the ATTESTATION_ALLOWLIST secret), "optional" (local development: no header → allowed).
// A header, when present, is always checked in full.
export type AttestationResult = "attested" | "allowlist" | "unchecked";

// Throws AttestationFailed (→ 403) or AttestationUnavailable (→ 503). "allowlist": the caller must check the
// verified identity with isAllowlisted() before it uses anything up.
export async function checkAttestation(request: Request, bytes: Uint8Array, env: Env): Promise<AttestationResult> {
  const header = request.headers.get(ATTESTATION_HEADER);
  if (!header) {
    if (env.ATTESTATION_POLICY === "optional") return "unchecked";
    if (env.ATTESTATION_POLICY === "allowlist") return "allowlist";
    throw new AttestationFailed("no attestation");
  }
  if (header.length > 16384) throw new AttestationFailed("attestation too long");
  const credentials = parseCredentials(env.PLAY_INTEGRITY_CREDENTIALS);
  if (!credentials) throw new AttestationUnavailable("PLAY_INTEGRITY_CREDENTIALS not set");
  check(await decode(header, env, credentials), await sha256Hex(bytes), env);
  return "attested";
}

// Whether this verified identity may sign in without attestation (staging test accounts, "provider:subject").
export function isAllowlisted(env: Env, provider: string, subject: string): boolean {
  return list(env.ATTESTATION_ALLOWLIST ?? "").includes(`${provider}:${subject}`);
}
