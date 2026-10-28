// Short-lived ES256 tokens for the chat and calls services (POST /v1/chat/token), and the public key they verify
// them with (GET /.well-known/jwks.json). Those services never see a session token and have no login of their own.
// The private key is the Worker secret CHAT_TOKEN_SIGNING_KEY (a private P-256 JWK with its thumbprint as kid),
// made and stored by scripts/set-chat-token-key.sh. Rotating it: run the script again; tokens signed with the old
// key stop verifying, and the apps fetch a new token on the 401 (they live at most 15 minutes anyway).
import { importJWK, SignJWT, type JWK } from "jose";
import { randomBase64Url } from "./crypto";
import type { Env } from "./env";
import { error, json } from "./http";
import { membership } from "./membership";
import { authenticate, type Session } from "./sessions";

export const MAX_TTL_SECONDS = 900;
const MIN_TTL_SECONDS = 60;

interface SigningKey {
  kid: string;
  key: CryptoKey;
  publicJwk: JWK;
}

// Per isolate, keyed by the secret's value (a new secret means a new isolate anyway).
let cached: { secret: string; key: SigningKey } | null = null;

// The parsed key, or null if the secret is not a private P-256 JWK with a kid.
export function parseSigningKey(secret: string | undefined): JWK | null {
  if (!secret) return null;
  let jwk: unknown;
  try {
    jwk = JSON.parse(secret);
  } catch {
    return null;
  }
  if (typeof jwk !== "object" || jwk === null) return null;
  const k = jwk as Record<string, unknown>;
  const text = (v: unknown) => typeof v === "string" && v.length > 0;
  if (k.kty !== "EC" || k.crv !== "P-256" || !text(k.x) || !text(k.y) || !text(k.d) || !text(k.kid)) return null;
  return k;
}

async function signingKey(env: Env): Promise<SigningKey | null> {
  const secret = env.CHAT_TOKEN_SIGNING_KEY;
  if (cached && cached.secret === secret) return cached.key;
  const jwk = parseSigningKey(secret);
  if (!jwk || !secret) return null;
  const key = (await importJWK({ ...jwk, alg: "ES256" }, "ES256")) as CryptoKey;
  const kid = jwk.kid ?? "";
  const publicJwk: JWK = { kty: "EC", crv: "P-256", x: jwk.x ?? "", y: jwk.y ?? "", kid, alg: "ES256", use: "sig" };
  cached = { secret, key: { kid, key, publicJwk } };
  return cached.key;
}

export function chatTokenTtl(env: Env): number {
  const ttl = Number(env.CHAT_TOKEN_TTL_SECONDS);
  if (!Number.isInteger(ttl) || ttl < MIN_TTL_SECONDS || ttl > MAX_TTL_SECONDS) {
    throw new Error(`CHAT_TOKEN_TTL_SECONDS must be an integer from ${MIN_TTL_SECONDS} to ${MAX_TTL_SECONDS}`);
  }
  return ttl;
}

export function chatTokenAudiences(list: string | undefined): string[] {
  return (list ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a !== "");
}

// Config problems for /health, by name only. A missing key is not one: chat and calls answer 503 until Stefan sets
// it, which shouldn't fail every API deploy before then.
export function chatTokenProblems(env: Partial<Env>): string[] {
  const found: string[] = [];
  if (env.CHAT_TOKEN_SIGNING_KEY !== undefined && !parseSigningKey(env.CHAT_TOKEN_SIGNING_KEY)) {
    found.push("CHAT_TOKEN_SIGNING_KEY invalid");
  }
  if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(env.CHAT_TOKEN_ISSUER ?? "")) {
    found.push("CHAT_TOKEN_ISSUER not an http(s) URL");
  }
  if (chatTokenAudiences(env.CHAT_TOKEN_AUDIENCES).length === 0) found.push("CHAT_TOKEN_AUDIENCES empty");
  try {
    chatTokenTtl(env as Env);
  } catch {
    found.push("CHAT_TOKEN_TTL_SECONDS invalid");
  }
  return found;
}

// The parent's current session epoch (0 until the first logout-all), read together with the session in one
// statement, or null if the session is gone. Logout-all increments the epoch and deletes the sessions in one
// transaction, so a request authenticated just before it either sees the old epoch (which the services then refuse)
// or no session at all, never the new epoch (api #81).
export async function sessionEpoch(env: Env, session: Session): Promise<number | null> {
  return await env.DB.prepare(
    "SELECT p.session_epoch FROM sessions s JOIN parents p ON p.id = s.parent_id WHERE s.token_hash = ? AND s.parent_id = ?",
  )
    .bind(session.tokenHash, session.parentId)
    .first<number>("session_epoch");
}

const notConfigured = () => error(503, "not_configured", "Chat tokens are not available yet. Try again later.");

export async function handleJwks(_request: Request, env: Env): Promise<Response> {
  const key = await signingKey(env);
  if (!key) return notConfigured();
  return json({ keys: [key.publicJwk] }, 200, { "cache-control": "public, max-age=300" });
}

const signInFirst = () =>
  error(401, "unauthorized", "Sign in first: send Authorization: Bearer <session token>.", {
    "www-authenticate": "Bearer",
  });

export async function handleChatToken(request: Request, env: Env): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return signInFirst();
  const ttl = chatTokenTtl(env);
  const key = await signingKey(env);
  if (!key) return notConfigured();
  const source = membership();
  const device = await source.device(env, session);
  if (device === null) {
    return error(409, "device_required", "Register this device first (POST /v1/devices), then ask again.");
  }
  const conversations = await source.conversations(env, session.parentId);
  // Last read before signing: a logout-all after it raises the epoch above this token's `sep`.
  const epoch = await sessionEpoch(env, session);
  if (epoch === null) return signInFirst();
  const now = Math.floor(Date.now() / 1000);
  // `sep`: the parent's session epoch. POST /v1/auth/logout-all increments it and tells the chat and calls
  // services, which then refuse tokens with a lower one (api #81).
  const token = await new SignJWT({ dev: device, role: "parent", conv: conversations, sep: epoch })
    .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "JWT" })
    .setIssuer(env.CHAT_TOKEN_ISSUER)
    .setAudience(chatTokenAudiences(env.CHAT_TOKEN_AUDIENCES))
    .setSubject(session.parentId)
    .setJti(randomBase64Url(16))
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(key.key);
  return json({ token, expiresAt: new Date((now + ttl) * 1000).toISOString() });
}
