// The stable v1 endpoints: sign-in with Apple or Google, the signed-in parent, logout.
import { classify } from "./age";
import { appleSignIn, googleSignIn, readJson, type SignInRequest } from "./body";
import type { Env } from "./env";
import { empty, error, json } from "./http";
import { ProviderUnavailable } from "./jwks";
import { getParent, signIn } from "./parents";
import { InvalidToken, verifyIdToken, type Provider } from "./providers";
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

  const category = classify(input.ageRange);
  if (category === "minor") {
    console.log(JSON.stringify({ msg: "sign-in rejected", provider, reason: "minor", source: input.ageRange.source }));
    return error(403, "minor_not_allowed", "Only adults (18+) can create a ZapaKid parent account.");
  }

  const result = await signIn(env, identity, input.ageRange, category, input.displayName);
  return json(result);
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
