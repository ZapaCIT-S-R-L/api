// The stable v1 endpoints: sign-in with Apple or Google, the signed-in parent, logout.
import { decide, type AgeRange } from "./age";
import { appleSignIn, googleSignIn, invalid, onlyFields, readJson, readJsonBody, type SignInRequest } from "./body";
import type { Env } from "./env";
import { empty, error, json } from "./http";
import { ProviderUnavailable } from "./jwks";
import { deviceRemovedEvents, flushMembershipEvents, sessionsRevokedEvent } from "./membership-events";
import { checkNonceClaim, consumeNonce, InvalidNonce, issueNonce } from "./nonces";
import { getParent, setDisplayName, signIn } from "./parents";
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

// GET reads the signed-in parent; PATCH changes their display name (the only field a parent edits).
export async function handleMe(request: Request, env: Env): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  if (request.method === "PATCH") {
    const body = await readJson(request);
    onlyFields(body, ["displayName"], "the body");
    await setDisplayName(env, session.parentId, displayNameFrom(body.displayName));
  }
  const parent = await getParent(env, session.parentId);
  if (!parent) return unauthorized();
  return json(parent);
}

const MAX_DISPLAY_NAME = 40;

// Trimmed, 1-40 characters, no control characters (names show in other phones' member lists and chats).
function displayNameFrom(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  // eslint-disable-next-line no-control-regex
  if (name.length === 0 || name.length > MAX_DISPLAY_NAME || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    throw invalid(`displayName must be 1 to ${MAX_DISPLAY_NAME} characters, without control characters.`);
  }
  return name;
}

// Signs out every session of the signed-in parent (a lost phone, or "sign out everywhere"), and bumps the parent's
// session epoch so chat tokens already issued stop working at the chat and calls services too (api #81): the
// account.sessions_revoked event carries the new epoch. With ?removeDevices=true the parent's registered devices
// go as well (a device.removed event each), so other phones stop sealing messages to the lost phone; every phone
// registers again at its next sign-in.
export async function handleLogoutAll(request: Request, env: Env): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  const removeDevices = new URL(request.url).searchParams.get("removeDevices");
  if (removeDevices !== null && removeDevices !== "true" && removeDevices !== "false") {
    throw invalid("removeDevices must be true or false.");
  }
  const parentId = session.parentId;
  // One transaction: the device.removed events are read from the device table right before the delete, so every
  // device the delete removes has its event, including one registered concurrently (api #84 review).
  await env.DB.batch([
    env.DB.prepare("UPDATE parents SET session_epoch = session_epoch + 1 WHERE id = ?").bind(parentId),
    env.DB.prepare("DELETE FROM sessions WHERE parent_id = ?").bind(parentId),
    ...(removeDevices === "true"
      ? [
          deviceRemovedEvents(env, "account_id = ?", [parentId]),
          env.DB.prepare("DELETE FROM devices WHERE account_id = ?").bind(parentId),
        ]
      : []),
    sessionsRevokedEvent(env, parentId),
  ]);
  await flushMembershipEvents(env);
  return empty(204);
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return unauthorized();
  const at = new Date().toISOString();
  await env.DB.batch([
    // Read the device and record the clears in the same transaction as logout. Other phones keep their targets.
    env.DB.prepare(
      `INSERT INTO membership_outbox (body, created_at)
       SELECT json_object('v', 1, 'id', ?1, 'type', 'device.upserted', 'occurredAt', ?2,
         'accountId', account_id, 'deviceId', device_id, 'registrationId', registration_id,
         'push', NULL, 'alertPush', NULL), ?2
       FROM devices WHERE account_id = ?3 AND device_id = ?4
         AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ?5)`,
    ).bind(crypto.randomUUID(), at, session.parentId, session.deviceId, session.tokenHash),
    env.DB.prepare(
      `UPDATE devices SET push_provider = NULL, push_token = NULL, alert_push_token = NULL
       WHERE account_id = ? AND device_id = ? AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ?)`,
    ).bind(session.parentId, session.deviceId, session.tokenHash),
    env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(session.tokenHash),
  ]);
  await flushMembershipEvents(env);
  return empty(204);
}
