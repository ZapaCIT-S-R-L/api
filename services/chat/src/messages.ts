// Sending, fetching and acknowledging sealed envelopes, and the live stream. The server checks who may send to
// whom and that every current device of every member gets its own envelope; it never looks inside one.
import type { Caller } from "./auth";
import { isDeviceId, isRegistrationId, onlyFields, readJson, UUID, ACCOUNT_ID } from "./body";
import { assertOpen, devicesOf, requireMembership } from "./conversations";
import type { Env } from "./env";
import { empty, HttpError, invalid, json } from "./http";
import { limit } from "./limits";
import { pushProvider, pushTargets } from "./push";
import { roomOf, type EnvelopeType, type StoredEnvelope } from "./room";

export const MAX_ENVELOPES = 256;
export const MAX_CONTENT_BYTES = 64 * 1024;
export const MAX_SEND_BYTES = 2 * 1024 * 1024;
const TYPES = new Set<EnvelopeType>(["prekey_message", "message", "sender_key_message"]);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodedLength(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}

// The caller's device must be registered with the account service (it gets envelopes like any other device).
export async function requireRegisteredDevice(env: Env, caller: Caller): Promise<void> {
  const row = await env.DB.prepare("SELECT 1 FROM devices WHERE account_id = ?1 AND device_id = ?2")
    .bind(caller.accountId, caller.deviceId)
    .first();
  if (!row) throw new HttpError(403, "device_not_registered", "Register this device with the account service first.");
}

const key = (accountId: string, deviceId: number) => `${accountId}:${String(deviceId)}`;
const address = (k: string) => {
  const i = k.lastIndexOf(":");
  return { accountId: k.slice(0, i), deviceId: Number(k.slice(i + 1)) };
};

export async function handleSend(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  caller: Caller,
  conversationId: string,
): Promise<Response> {
  const { conversation, members } = await requireMembership(env, caller, conversationId);
  assertOpen(conversation);
  await requireRegisteredDevice(env, caller);
  await limit(env.SEND_LIMITER, `send:${key(caller.accountId, caller.deviceId)}`);
  const body = await readJson(request, MAX_SEND_BYTES);
  onlyFields(body, ["messageId", "envelopes"]);
  const { messageId, envelopes } = body;
  if (typeof messageId !== "string" || !UUID.test(messageId)) throw invalid("messageId: a lowercase UUID.");
  if (!Array.isArray(envelopes) || envelopes.length < 1 || envelopes.length > MAX_ENVELOPES) {
    throw invalid(`envelopes: 1 to ${MAX_ENVELOPES}.`);
  }

  const given = new Map<string, { registrationId: number; envelope: StoredEnvelope }>();
  for (const raw of envelopes as unknown[]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid("envelopes: objects.");
    const e = raw as Record<string, unknown>;
    onlyFields(e, ["recipientAccountId", "recipientDeviceId", "recipientRegistrationId", "type", "content"]);
    const { recipientAccountId, recipientDeviceId, recipientRegistrationId, type, content } = e;
    if (typeof recipientAccountId !== "string" || !ACCOUNT_ID.test(recipientAccountId)) {
      throw invalid("recipientAccountId invalid.");
    }
    if (!isDeviceId(recipientDeviceId)) throw invalid("recipientDeviceId: 1 to 127.");
    if (!isRegistrationId(recipientRegistrationId)) throw invalid("recipientRegistrationId: 1 to 16383.");
    if (typeof type !== "string" || !TYPES.has(type as EnvelopeType))
      throw invalid("type: a libsignal ciphertext type.");
    if (typeof content !== "string" || content.length === 0 || !BASE64.test(content)) throw invalid("content: base64.");
    if (decodedLength(content) > MAX_CONTENT_BYTES) {
      throw new HttpError(413, "payload_too_large", "An envelope is over 64 KiB.");
    }
    const k = key(recipientAccountId, recipientDeviceId);
    if (given.has(k)) throw invalid("envelopes: one per device.");
    given.set(k, {
      registrationId: recipientRegistrationId,
      envelope: { recipientAccountId, recipientDeviceId, type: type as EnvelopeType, content },
    });
  }

  // Every current device of every member, except the sending device.
  const devices = await devicesOf(
    env,
    members.map((m) => m.account_id),
  );
  const expected = new Map<string, number>();
  for (const [accountId, list] of devices) {
    for (const d of list) {
      if (accountId === caller.accountId && d.deviceId === caller.deviceId) continue;
      expected.set(key(accountId, d.deviceId), d.registrationId);
    }
  }
  const missing = [...expected.keys()].filter((k) => !given.has(k));
  const extra = [...given.keys()].filter((k) => !expected.has(k));
  if (missing.length > 0 || extra.length > 0) {
    throw new HttpError(409, "stale_devices", "The members' devices changed. Refresh the conversation and retry.", {
      missingDevices: missing.map(address),
      extraDevices: extra.map(address),
    });
  }
  const stale = [...given.entries()].filter(([k, g]) => expected.get(k) !== g.registrationId).map(([k]) => k);
  if (stale.length > 0) {
    throw new HttpError(410, "stale_registration", "A device was re-installed. Fetch its keys again.", {
      staleDevices: stale.map(address),
    });
  }

  const result = await roomOf(env, conversationId).send({
    conversationId,
    messageId,
    senderAccountId: caller.accountId,
    senderDeviceId: caller.deviceId,
    envelopes: [...given.values()].map((g) => g.envelope),
  });
  // A new message brings the conversation back for members who had deleted it.
  await env.DB.prepare(
    "UPDATE conversation_members SET deleted_at = NULL WHERE conversation_id = ?1 AND deleted_at IS NOT NULL",
  )
    .bind(conversationId)
    .run();
  if (result.offline.length > 0) {
    ctx.waitUntil(
      pushTargets(env, result.offline)
        .then((targets) => pushProvider(env).wake(targets))
        .catch((e: unknown) => {
          console.error(JSON.stringify({ msg: "push_failed", err: String(e) }));
        }),
    );
  }
  return json({ messageId, serverTimestamp: result.serverTimestamp }, 202);
}

export async function handleFetch(
  request: Request,
  env: Env,
  caller: Caller,
  conversationId: string,
): Promise<Response> {
  await requireMembership(env, caller, conversationId);
  const text = new URL(request.url).searchParams.get("limit") ?? "100";
  const n = Number(text);
  if (!/^\d{1,3}$/.test(text) || n < 1 || n > 100) throw invalid("limit: 1 to 100.");
  const page = await roomOf(env, conversationId).queued(conversationId, caller.accountId, caller.deviceId, n);
  return json(page);
}

export async function handleAck(request: Request, env: Env, caller: Caller, conversationId: string): Promise<Response> {
  await requireMembership(env, caller, conversationId);
  const body = await readJson(request);
  onlyFields(body, ["envelopeIds"]);
  const { envelopeIds } = body;
  if (
    !Array.isArray(envelopeIds) ||
    envelopeIds.length < 1 ||
    envelopeIds.length > 100 ||
    !envelopeIds.every((id): id is string => typeof id === "string" && UUID.test(id))
  ) {
    throw invalid("envelopeIds: 1 to 100 envelope ids.");
  }
  await roomOf(env, conversationId).ack(caller.accountId, caller.deviceId, envelopeIds);
  return empty();
}

export async function handleStream(
  request: Request,
  env: Env,
  caller: Caller,
  conversationId: string,
): Promise<Response> {
  await requireMembership(env, caller, conversationId);
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(426, "upgrade_required", "Open a WebSocket.", {}, { upgrade: "websocket" });
  }
  await requireRegisteredDevice(env, caller);
  await limit(env.CONNECT_LIMITER, `connect:${key(caller.accountId, caller.deviceId)}`);
  const headers = new Headers({
    upgrade: "websocket",
    "x-chat-conversation": conversationId,
    "x-chat-account": caller.accountId,
    "x-chat-device": String(caller.deviceId),
    "x-chat-exp": String(caller.exp),
  });
  return roomOf(env, conversationId).fetch(new Request("https://room/stream", { headers }));
}
