// Sign in with Apple on Android, through Apple's web flow (openapi.yaml: /v1/auth/apple/web, /callback,
// /exchange). The app proves it started the flow with PKCE (S256); Apple's identity token is verified at the
// callback and never leaves the server or is stored; the app gets only a one-time code in the app link fragment.
import { BadRequest, invalid, nonce, onlyFields, parseAgeRange, readForm, readJson, readJsonBody } from "./body";
import { randomBase64Url, sha256Base64Url, sha256Hex } from "./crypto";
import type { Env } from "./env";
import { error, json } from "./http";
import { ProviderUnavailable } from "./jwks";
import { InvalidToken, verifyIdToken, type Identity } from "./providers";
import { allowlistRefusal, attest, finishSignIn } from "./routes";

const FLOW_TTL_SECONDS = 600;
const CODE_TTL_SECONDS = 120;
const TOKEN_43 = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

export async function handleAppleWebStart(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  onlyFields(body, ["codeChallenge", "codeChallengeMethod"], "the body");
  if (body.codeChallengeMethod !== "S256") throw invalid("codeChallengeMethod must be S256.");
  if (typeof body.codeChallenge !== "string" || !TOKEN_43.test(body.codeChallenge)) {
    throw invalid("codeChallenge must be base64url(SHA-256(codeVerifier)), 43 characters.");
  }
  const state = randomBase64Url(32);
  const expiresAt = inSeconds(FLOW_TTL_SECONDS);
  await env.DB.prepare(
    "INSERT INTO apple_web_flows (state_hash, code_challenge, created_at, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(await sha256Hex(state), body.codeChallenge, new Date().toISOString(), expiresAt)
    .run();
  return json({ state, expiresAt });
}

// 303 to the app link with the result in the fragment (never sent to a server, kept out of logs and Referer).
function handBack(env: Env, params: Record<string, string>): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: `${env.APPLE_WEB_REDIRECT_URL}#${new URLSearchParams(params).toString()}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "strict-transport-security": "max-age=31536000; includeSubDomains",
    },
  });
}

// Apple sends the name only on the first sign-in, as JSON in the `user` field.
function nameFrom(user: string | null): string | null {
  if (!user) return null;
  try {
    const parsed = JSON.parse(user) as { name?: { firstName?: unknown; lastName?: unknown } };
    const parts = [parsed.name?.firstName, parsed.name?.lastName].filter((p): p is string => typeof p === "string");
    return parts.join(" ").trim().slice(0, 100) || null;
  } catch {
    return null;
  }
}

export async function handleAppleWebCallback(request: Request, env: Env): Promise<Response> {
  let form: URLSearchParams | null;
  try {
    form = await readForm(request);
  } catch (e) {
    if (e instanceof BadRequest) return handBack(env, { error: "invalid_request" });
    throw e;
  }
  if (!form) return handBack(env, { error: "invalid_request" });

  const state = form.get("state") ?? "";
  if (!TOKEN_43.test(state)) return handBack(env, { error: "invalid_state" });

  // Close the flow first, whatever happens next: a state works once.
  const now = new Date().toISOString();
  const flow = await env.DB.prepare(
    `UPDATE apple_web_flows SET code_expires_at = ?
     WHERE state_hash = ? AND code_expires_at IS NULL AND expires_at > ? RETURNING state_hash`,
  )
    .bind(inSeconds(CODE_TTL_SECONDS), await sha256Hex(state), now)
    .first<{ state_hash: string }>();
  if (!flow) return handBack(env, { error: "invalid_state" });

  const appleError = form.get("error");
  if (appleError !== null) {
    return handBack(env, { error: /^[a-z_]{1,40}$/.test(appleError) ? appleError : "apple_error", state });
  }

  let identity: Identity;
  try {
    identity = await verifyIdToken("apple", form.get("id_token") ?? "", env);
  } catch (e) {
    if (e instanceof InvalidToken) {
      console.log(JSON.stringify({ msg: "apple web callback rejected", reason: e.message }));
      return handBack(env, { error: "invalid_token", state });
    }
    if (e instanceof ProviderUnavailable) return handBack(env, { error: "provider_unavailable", state });
    throw e;
  }

  const code = randomBase64Url(32);
  await env.DB.prepare(
    `UPDATE apple_web_flows SET code_hash = ?, subject = ?, email = ?, nonce_claim = ?, display_name = ?
     WHERE state_hash = ?`,
  )
    .bind(
      await sha256Hex(code),
      identity.subject,
      identity.email,
      typeof identity.nonce === "string" ? identity.nonce : null,
      nameFrom(form.get("user")),
      flow.state_hash,
    )
    .run();
  return handBack(env, { code, state });
}

interface FlowRow {
  code_challenge: string;
  code_expires_at: string;
  subject: string;
  email: string | null;
  nonce_claim: string | null;
  display_name: string | null;
}

export async function handleAppleWebExchange(request: Request, env: Env): Promise<Response> {
  const { body, bytes } = await readJsonBody(request);
  onlyFields(body, ["code", "codeVerifier", "nonce", "ageRange"], "the body");
  if (typeof body.code !== "string" || !TOKEN_43.test(body.code)) throw invalid("code is required.");
  if (typeof body.codeVerifier !== "string" || !VERIFIER.test(body.codeVerifier)) {
    throw invalid("codeVerifier must be 43-128 characters (RFC 7636).");
  }
  const sentNonce = nonce(body);
  const ageRange = parseAgeRange(body.ageRange);
  const attestation = await attest(request, bytes, env);
  if (attestation instanceof Response) return attestation;

  // Any attempt uses the code up, so a wrong verifier can't be retried.
  const row = await env.DB.prepare("DELETE FROM apple_web_flows WHERE code_hash = ? RETURNING *")
    .bind(await sha256Hex(body.code))
    .first<FlowRow>();
  const valid =
    row !== null &&
    Date.parse(row.code_expires_at) > Date.now() &&
    (await sha256Base64Url(body.codeVerifier)) === row.code_challenge;
  if (!valid) {
    console.log(JSON.stringify({ msg: "apple web exchange rejected", found: row !== null }));
    return error(401, "invalid_code", "The sign-in code is unknown, expired or used. Sign in with Apple again.");
  }

  const identity: Identity = {
    provider: "apple",
    subject: row.subject,
    email: row.email,
    name: null,
    nonce: row.nonce_claim,
  };
  const refused = allowlistRefusal(attestation, env, identity);
  if (refused) return refused;
  return finishSignIn(env, identity, sentNonce, ageRange, row.display_name);
}
