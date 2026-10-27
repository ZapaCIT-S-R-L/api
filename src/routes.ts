// The stable v1 endpoints: sign-in with Apple or Google, the signed-in parent, logout.
import { decide, type AgeRange } from "./age";
import { appleSignIn, googleSignIn, readJsonBody, type SignInRequest } from "./body";
import type { Env } from "./env";
import { empty, error, json } from "./http";
import { ProviderUnavailable } from "./jwks";
import { checkNonceClaim, consumeNonce, InvalidNonce, issueNonce } from "./nonces";
import { getParent, signIn } from "./parents";
import {
  AttestationFailed,
  AttestationUnavailable,
  checkAttestation,
  isAllowlisted,
  type AttestationResult,
} from "./play-integrity";
import { InvalidToken, verifyIdToken, type Identity, type Provider } from "./providers";
import { authenticate } from "./sessions";

const unauthorized = () =>
  error(401, "unauthorized", "Sign in first: send Authorization: Bearer <session token>.", {
    "www-authenticate": "Bearer",
  });

export async function handleSignIn(request: Request, env: Env, provider: Provider): Promise<Response> {
  const { body, bytes } = await readJsonBody(request);
  const input: SignInRequest = provider === "apple" ? appleSignIn(body) : googleSignIn(body);
  const attestation = await attest(request, bytes, env);
  if (attestation instanceof Response) return attestation;

  let identity;
  try {
    identity = await verifyIdToken(provider, input.token, env);
  } catch (e) {
    if (e instanceof InvalidToken) {
      console.log(JSON.stringify({ msg: "sign-in rejected", provider, reason: e.message }));
      return error(401, "invalid_token", "The sign-in token is not valid. Sign in again.");
    }
    if (e instanceof ProviderUnavailable) {
      console.error(JSON.stringify({ msg: "provider unavailable", provider, err: e.message }));
      return error(503, "provider_unavailable", "Sign-in is unavailable right now. Try again later.");
    }
    throw e;
  }

  const refused = allowlistRefusal(attestation, env, identity);
  if (refused) return refused;

  return finishSignIn(env, identity, input.nonce, input.ageRange, input.displayName);
}

// Shared by every sign-in: the token (already verified) must carry this sign-in's nonce, which is used up before
// the age check, so a rejected age range can't be retried with the same token. Then the age rules, then the
// session.
export async function finishSignIn(
  env: Env,
  identity: Identity,
  nonce: string,
  ageRange: AgeRange,
  displayName: string | null,
): Promise<Response> {
  const provider = identity.provider;
  try {
    const claim = await checkNonceClaim(identity.nonce, nonce);
    await consumeNonce(env, claim);
  } catch (e) {
    if (!(e instanceof InvalidNonce)) throw e;
    console.log(JSON.stringify({ msg: "sign-in rejected", provider, reason: e.message }));
    return error(401, "invalid_nonce", "The sign-in nonce is missing, wrong, expired or used. Get a new one.");
  }

  const age = decide(ageRange);
  if (age === "minor" || age === "declined") {
    console.log(JSON.stringify({ msg: "sign-in rejected", provider, reason: age, source: ageRange.source }));
    return age === "minor"
      ? error(403, "minor_not_allowed", "Only adults (18+) can create a ZapaKid parent account.")
      : error(403, "age_declined", "Share your age range to sign in: only adults (18+) can be parents.");
  }

  return json(await signIn(env, identity, ageRange, age, displayName));
}

// App attestation before anything is verified or used up: a refused request leaves the nonce and codes intact.
// Returns a refusal, or the result to pass to allowlistRefusal() once the identity is verified.
export async function attest(request: Request, bytes: Uint8Array, env: Env): Promise<Response | AttestationResult> {
  try {
    return await checkAttestation(request, bytes, env);
  } catch (e) {
    if (e instanceof AttestationFailed) {
      console.log(
        JSON.stringify({ msg: "attestation failed", path: new URL(request.url).pathname, reason: e.message }),
      );
      return error(
        403,
        "attestation_failed",
        "Use the ZapaKid app from Google Play or the App Store on a genuine device.",
      );
    }
    if (e instanceof AttestationUnavailable) {
      console.error(JSON.stringify({ msg: "attestation unavailable", reason: e.message }));
      return error(503, "attestation_unavailable", "Sign-in is unavailable right now. Try again later.");
    }
    throw e;
  }
}

const attestationFailed = () =>
  error(403, "attestation_failed", "Use the ZapaKid app from Google Play or the App Store on a genuine device.");

// For the "allowlist" policy: a request without attestation goes on only for an allowlisted identity.
export function allowlistRefusal(result: AttestationResult, env: Env, identity: Identity): Response | null {
  if (result !== "allowlist" || isAllowlisted(env, identity.provider, identity.subject)) return null;
  console.log(JSON.stringify({ msg: "attestation failed", reason: "no attestation, not allowlisted" }));
  return attestationFailed();
}

export async function handleNonce(_request: Request, env: Env): Promise<Response> {
  return json(await issueNonce(env));
}

export async function handleMe(request: Request, env: Env): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  const parent = await getParent(env, session.parentId);
  if (!parent) return unauthorized();
  return json(parent);
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(session.tokenHash).run();
  return empty(204);
}
