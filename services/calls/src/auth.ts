// Chat tokens from the account API (api: src/chat-token.ts): ES256, at most 15 minutes, `aud` must include this
// host. Calls has no login of its own and never sees a session token.
import { decodeProtectedHeader, errors, jwtVerify, type JWTPayload } from "jose";
import type { Env } from "./env";
import { getJwks } from "./jwks";
import { safeUrl } from "./urls";

const MAX_LIFETIME_SECONDS = 900;
const CLOCK_TOLERANCE_SECONDS = 30;
const MAX_SCOPES = 1000;

export type Role = "parent" | "kid";

export interface Caller {
  accountId: string;
  // libsignal device id (1-127): who key envelopes are for.
  deviceId: number;
  role: Role;
  // The token's `conv` claim: membership scopes (family:<id>, connection:<id>), never conversation ids. Checked for
  // shape only and not used to authorize: the chat service decides who is in a conversation (src/chat.ts).
  scopes: string[];
}

export class InvalidToken extends Error {}

// The bearer token from `Authorization: Bearer <token>`, or null.
export function bearerToken(request: Request): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/.exec(
    request.headers.get("authorization") ?? "",
  );
  return match?.[1] ?? null;
}

export async function authenticate(request: Request, env: Env): Promise<Caller> {
  const token = bearerToken(request);
  if (!token) throw new InvalidToken("no bearer token");
  return verifyChatToken(token, env);
}

export async function verifyChatToken(token: string, env: Env): Promise<Caller> {
  const url = safeUrl(env.ACCOUNT_JWKS_URL);
  if (!url) throw new Error("ACCOUNT_JWKS_URL is not a safe URL");
  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch {
    throw new InvalidToken("malformed token");
  }
  const keys = await getJwks(url.toString(), kid);
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      algorithms: ["ES256"],
      issuer: env.TOKEN_ISSUER,
      audience: env.TOKEN_AUDIENCE,
      requiredClaims: ["exp", "iat", "sub"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    }));
  } catch (e) {
    if (e instanceof errors.JOSEError) throw new InvalidToken(`${e.code}: ${e.message}`);
    throw e;
  }
  return claims(payload);
}

function claims(payload: JWTPayload): Caller {
  const { sub, dev, role, conv, iat, exp } = payload;
  if ((exp ?? 0) - (iat ?? 0) > MAX_LIFETIME_SECONDS) throw new InvalidToken("token lifetime over 15 minutes");
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 128) throw new InvalidToken("bad claim: sub");
  if (typeof dev !== "number" || !Number.isInteger(dev) || dev < 1 || dev > 127)
    throw new InvalidToken("bad claim: dev");
  if (role !== "parent" && role !== "kid") throw new InvalidToken("bad claim: role");
  if (
    !Array.isArray(conv) ||
    conv.length > MAX_SCOPES ||
    !conv.every((c): c is string => typeof c === "string" && c.length > 0 && c.length <= 128)
  ) {
    throw new InvalidToken("bad claim: conv");
  }
  return { accountId: sub, deviceId: dev, role, scopes: conv };
}
