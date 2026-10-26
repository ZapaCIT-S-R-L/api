// The stable v1 endpoints: sign-in with Apple or Google, the signed-in parent, logout.
import { decide, type AgeRange } from "./age";
import { appleSignIn, googleSignIn, readJson, type SignInRequest } from "./body";
import type { Env } from "./env";
import { empty, error, json } from "./http";
import { ProviderUnavailable } from "./jwks";
import { checkNonceClaim, consumeNonce, InvalidNonce, issueNonce } from "./nonces";
import { getParent, signIn } from "./parents";
import { InvalidToken, verifyIdToken, type Identity, type Provider } from "./providers";
import { authenticate } from "./sessions";

const unauthorized = () =>
  error(401, "unauthorized", "Sign in first: send Authorization: Bearer <session token>.", {
    "www-authenticate": "Bearer",
  });

export async function handleSignIn(request: Request, env: Env, provider: Provider): Promise<Response> {
  const body = await readJson(request);
  const input: SignInRequest = provider === "apple" ? appleSignIn(body) : googleSignIn(body);

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
