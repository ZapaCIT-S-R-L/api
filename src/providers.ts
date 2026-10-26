// Verifies Apple identity tokens and Google ID tokens: RS256 signature against the provider's published keys,
// issuer, audience (ZapaKid's app ids only), expiry. All JWT checks are jose's; the server adds no crypto of its own.
import { decodeProtectedHeader, errors, jwtVerify, type JWTPayload } from "jose";
import type { Env } from "./env";
import { getJwks } from "./jwks";

export type Provider = "apple" | "google";

export interface Identity {
  provider: Provider;
  subject: string;
  email: string | null;
  name: string | null;
  // The token's `nonce` claim, checked by the caller against the sign-in nonce.
  nonce: unknown;
}

export class InvalidToken extends Error {}

const CLOCK_TOLERANCE_S = 30;

const CONFIG = {
  apple: {
    jwksUrl: "https://appleid.apple.com/auth/keys",
    issuers: ["https://appleid.apple.com"],
    audiences: (env: Env) => env.APPLE_AUDIENCES,
    override: (env: Env) => env.APPLE_JWKS_URL,
  },
  google: {
    jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    audiences: (env: Env) => env.GOOGLE_CLIENT_IDS,
    override: (env: Env) => env.GOOGLE_JWKS_URL,
  },
} as const;

// Local development may point at a JWKS server on this machine (test keys). Any other override is ignored, so a
// deployed Worker can only ever trust Apple's and Google's real keys.
function jwksUrl(official: string, override: string | undefined): string {
  if (!override) return official;
  try {
    const url = new URL(override);
    if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) return override;
  } catch {
    // ignored: invalid URL
  }
  return official;
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export async function verifyIdToken(provider: Provider, token: string, env: Env): Promise<Identity> {
  const config = CONFIG[provider];
  const audiences = list(config.audiences(env));
  if (audiences.length === 0) throw new InvalidToken(`${provider} sign-in is not configured`);

  let kid: string | undefined;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== "RS256") throw new InvalidToken(`unexpected alg ${String(header.alg).slice(0, 16)}`);
    kid = header.kid;
  } catch (e) {
    if (e instanceof InvalidToken) throw e;
    throw new InvalidToken("malformed token");
  }

  // Provider outages (ProviderUnavailable) propagate as is.
  const keys = await getJwks(jwksUrl(config.jwksUrl, config.override(env)), kid);

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      algorithms: ["RS256"],
      issuer: [...config.issuers],
      audience: audiences,
      clockTolerance: CLOCK_TOLERANCE_S,
      requiredClaims: ["sub", "exp", "iat"],
    }));
  } catch (e) {
    if (e instanceof errors.JOSEError) throw new InvalidToken(e.code);
    throw e;
  }

  if (typeof payload.sub !== "string" || payload.sub.length === 0 || payload.sub.length > 255) {
    throw new InvalidToken("bad subject");
  }
  // Apple sends email_verified as "true"/"false" strings, Google as booleans.
  const verified = payload.email_verified === true || payload.email_verified === "true";
  const email = verified && typeof payload.email === "string" && payload.email.length <= 320 ? payload.email : null;
  const name =
    provider === "google" && typeof payload.name === "string" ? payload.name.trim().slice(0, 100) || null : null;
  return { provider, subject: payload.sub, email, name, nonce: payload.nonce };
}
