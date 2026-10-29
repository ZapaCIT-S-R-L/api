// Chat tokens: short-lived ES256 JWTs from the account service. The chat service has no login of its own; it only
// checks the signature against the account service's JWKS and the claims below.
import { decodeProtectedHeader, errors, jwtVerify } from "jose";
import type { Env } from "./env";
import { HttpError } from "./http";
import { ACCOUNT_ID } from "./body";
import { allowedJwksUrl, getJwks, KeysUnavailable } from "./jwks";
import { deviceRemovedSince, revokedBefore } from "./membership";

export const MAX_TOKEN_SECONDS = 15 * 60;
const CLOCK_SKEW_SECONDS = 30;

export interface Caller {
  accountId: string;
  deviceId: number;
  role: "parent" | "kid";
  // Token expiry (seconds since the epoch): a stream is closed then.
  exp: number;
  // When the token was issued (seconds since the epoch).
  iat: number;
  // The account's session epoch when the token was issued (`sep`; 0 if the claim is missing). The account service
  // increments it on logout-all (api #81); tokens from before the current epoch are refused.
  sep: number;
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
  const { sub, dev, role, iat, exp, sep } = payload;
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
  if (sep !== undefined && (typeof sep !== "number" || !Number.isInteger(sep) || sep < 0)) {
    throw unauthorized("Invalid sep claim.");
  }
  const epoch = sep ?? 0;
  if (epoch < (await revokedBefore(env, sub))) {
    throw unauthorized("This chat token was revoked (signed out everywhere). Sign in again.");
  }
  // The device was removed after the token was issued (a parent revoked the kid's phone, the kid signed out, or a
  // logout-all removed the devices, api #92): the phone must not fetch, ack, read attachments or stream any more.
  if (await deviceRemovedSince(env, sub, deviceId, iat)) {
    throw unauthorized("This chat token's device was removed (unpaired or signed out). Sign in or pair again.");
  }
  return { accountId: sub, deviceId, role, exp, iat, sep: epoch };
}
