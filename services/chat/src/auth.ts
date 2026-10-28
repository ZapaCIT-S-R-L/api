// Chat tokens: short-lived ES256 JWTs from the account service. The chat service has no login of its own; it only
// checks the signature against the account service's JWKS and the claims below.
import { decodeProtectedHeader, errors, jwtVerify } from "jose";
import type { Env } from "./env";
import { HttpError } from "./http";
import { ACCOUNT_ID } from "./body";
import { allowedJwksUrl, getJwks, KeysUnavailable } from "./jwks";

export const MAX_TOKEN_SECONDS = 15 * 60;
const CLOCK_SKEW_SECONDS = 30;

export interface Caller {
  accountId: string;
  deviceId: number;
  role: "parent" | "kid";
  // Token expiry (seconds since the epoch): a stream is closed then.
  exp: number;
}

const unauthorized = (message: string) =>
  new HttpError(401, "unauthorized", message, {}, { "www-authenticate": "Bearer" });

export async function authenticate(request: Request, env: Env): Promise<Caller> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header);
  if (!match?.[1]) throw unauthorized("Send a chat token: Authorization: Bearer <token>.");
  const token = match[1];
  if (!allowedJwksUrl(env.ACCOUNT_JWKS_URL)) throw new Error("ACCOUNT_JWKS_URL is not an https URL");

  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch {
    throw unauthorized("Malformed token.");
  }
  let payload: Record<string, unknown>;
  try {
    const keys = await getJwks(env.ACCOUNT_JWKS_URL, kid);
    const verified = await jwtVerify(token, keys, {
      algorithms: ["ES256"],
      issuer: env.TOKEN_ISSUER,
      audience: env.TOKEN_AUDIENCE,
      requiredClaims: ["sub", "exp", "iat"],
      clockTolerance: CLOCK_SKEW_SECONDS,
    });
    payload = verified.payload;
  } catch (e) {
    if (e instanceof KeysUnavailable) {
      console.error(JSON.stringify({ msg: "jwks_unavailable", err: e.message }));
      throw new HttpError(503, "auth_unavailable", "The account service's keys can't be fetched. Retry later.");
    }
    if (e instanceof errors.JOSEError) throw unauthorized("Invalid or expired chat token.");
    throw e;
  }
  const { sub, dev, role, iat, exp } = payload;
  if (typeof iat !== "number" || typeof exp !== "number" || exp - iat > MAX_TOKEN_SECONDS) {
    throw unauthorized("A chat token may live at most 15 minutes.");
  }
  if (iat > Date.now() / 1000 + CLOCK_SKEW_SECONDS) throw unauthorized("Token issued in the future.");
  if (typeof sub !== "string" || !ACCOUNT_ID.test(sub)) throw unauthorized("Invalid sub claim.");
  const deviceId = typeof dev === "string" && /^\d{1,3}$/.test(dev) ? Number(dev) : dev;
  if (typeof deviceId !== "number" || !Number.isInteger(deviceId) || deviceId < 1 || deviceId > 127) {
    throw unauthorized("Invalid dev claim.");
  }
  if (role !== "parent" && role !== "kid") throw unauthorized("Invalid role claim.");
  return { accountId: sub, deviceId, role, exp };
}
