// App attestation on sign-in. Android: a standard Play Integrity token in ZapaKid-Attestation, bound to the request
// (requestHash = SHA-256 hex of the exact body bytes). The server decodes it with Google's decodeIntegrityToken API,
// authenticated as a service account without any Google key: the API signs a 5-minute assertion with its own key
// (CHAT_TOKEN_SIGNING_KEY; Google finds the public half via /.well-known/openid-configuration), Google's STS trades
// it for a federated token (Workload Identity Federation), and that impersonates the service account. Then it checks
// the verdicts. iOS: an App Attest assertion (src/app-attest.ts), told apart by its "v1 " prefix.
import { SignJWT } from "jose";
import { isAppAttestHeader, verifyAssertion } from "./app-attest";
import { AttestationFailed, AttestationUnavailable } from "./attestation-errors";
import { signingKey } from "./chat-token";
import { sha256Hex } from "./crypto";
import type { Env } from "./env";

export const ATTESTATION_HEADER = "zapakid-attestation";
const STS_URL = "https://sts.googleapis.com/v1/token";
const ASSERTION_SUBJECT = "play-integrity";
const SCOPE = "https://www.googleapis.com/auth/playintegrity";
const MAX_AGE_MS = 10 * 60_000;
const MAX_SKEW_MS = 60_000;
const TIMEOUT_MS = 5000;

export { AttestationFailed, AttestationUnavailable };

interface Federation {
  audience: string;
  serviceAccount: string;
}

let accessToken: { serviceAccount: string; token: string; expiresAt: number } | null = null;

export function resetPlayIntegrityCache(): void {
  accessToken = null;
}

export function federation(env: Partial<Env>): Federation | null {
  const audience = env.PLAY_INTEGRITY_WIF_AUDIENCE?.trim() ?? "";
  const serviceAccount = env.PLAY_INTEGRITY_SERVICE_ACCOUNT?.trim() ?? "";
  if (!audience.startsWith("//iam.googleapis.com/") || !/^[^@\s/]+@[^@\s/]+$/.test(serviceAccount)) return null;
  return { audience, serviceAccount };
}

async function getAccessToken(env: Env, fed: Federation): Promise<string> {
  if (accessToken && accessToken.serviceAccount === fed.serviceAccount && accessToken.expiresAt > Date.now() + 60_000) {
    return accessToken.token;
  }
  const key = await signingKey(env);
  if (!key) throw new AttestationUnavailable("CHAT_TOKEN_SIGNING_KEY not set");
  // The provider's default audience is its resource name as an https URL.
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "JWT" })
    .setIssuer(env.CHAT_TOKEN_ISSUER)
    .setSubject(ASSERTION_SUBJECT)
    .setAudience(`https:${fed.audience}`)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key.key);
  const sts = await fetchOrUnavailable(STS_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: fed.audience,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: assertion,
    }).toString(),
  });
  if (!sts.ok) throw new AttestationUnavailable(`STS answered ${sts.status}`);
  const federated = (await sts.json().catch(() => ({}))) as { access_token?: unknown };
  if (typeof federated.access_token !== "string") throw new AttestationUnavailable("no federated token");
  const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${fed.serviceAccount}:generateAccessToken`;
  const res = await fetchOrUnavailable(url, {
    method: "POST",
    headers: { authorization: `Bearer ${federated.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ scope: [SCOPE], lifetime: "3600s" }),
  });
  if (!res.ok) throw new AttestationUnavailable(`generateAccessToken answered ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { accessToken?: unknown; expireTime?: unknown };
  if (typeof body.accessToken !== "string") throw new AttestationUnavailable("no access token");
  const expiresAt = typeof body.expireTime === "string" ? Date.parse(body.expireTime) : NaN;
  accessToken = {
    serviceAccount: fed.serviceAccount,
    token: body.accessToken,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 3600_000,
  };
  return body.accessToken;
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

async function decode(token: string, env: Env, fed: Federation): Promise<Verdict> {
  const url = `https://playintegrity.googleapis.com/v1/${encodeURIComponent(env.PLAY_PACKAGE_NAME)}:decodeIntegrityToken`;
  const res = await fetchOrUnavailable(url, {
    method: "POST",
    headers: { authorization: `Bearer ${await getAccessToken(env, fed)}`, "content-type": "application/json" },
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
  if (isAppAttestHeader(header)) {
    await verifyAssertion(header, bytes, env);
    return "attested";
  }
  const fed = federation(env);
  if (!fed) throw new AttestationUnavailable("PLAY_INTEGRITY_WIF_AUDIENCE or PLAY_INTEGRITY_SERVICE_ACCOUNT not set");
  check(await decode(header, env, fed), await sha256Hex(bytes), env);
  return "attested";
}

// Whether this verified identity may sign in without attestation (staging test accounts, "provider:subject").
export function isAllowlisted(env: Env, provider: string, subject: string): boolean {
  return list(env.ATTESTATION_ALLOWLIST ?? "").includes(`${provider}:${subject}`);
}
