// Encrypted attachments: the phone encrypts the file with a fresh key, uploads only the ciphertext through a one-time
// URL, and sends the attachment id, key and digest inside the end-to-end encrypted message. Recipients ask for a
// one-time download URL. One-time URLs carry a random token (only its SHA-256 is stored), are valid 15 minutes and
// work once, so the apps can hand them to background transfers without the chat token.
import type { Caller } from "./auth";
import { base64url, CONVERSATION_ID, onlyFields, randomId, readJson } from "./body";
import { assertOpen, requireMembership } from "./conversations";
import type { Env } from "./env";
import { empty, HttpError, invalid, json, notFound, SECURITY_HEADERS } from "./http";
import { limit } from "./limits";
import { requireRegisteredDevice } from "./messages";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const URL_TTL_MS = 15 * 60 * 1000;
// Reservations never uploaded (or uploads that broke off) are removed after this.
export const ABANDONED_MS = 60 * 60 * 1000;
const ATTACHMENT_ID = /^a_[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const gone = () => notFound("Unknown, expired or already used URL.");

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function tokenParam(request: Request): string {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!TOKEN.test(token)) throw gone();
  return token;
}

export async function handleReserve(request: Request, env: Env, caller: Caller): Promise<Response> {
  const body = await readJson(request);
  onlyFields(body, ["conversationId", "size"]);
  const { conversationId, size } = body;
  if (typeof conversationId !== "string" || !CONVERSATION_ID.test(conversationId)) throw invalid("conversationId.");
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > MAX_ATTACHMENT_BYTES) {
    throw invalid(`size: 1 to ${MAX_ATTACHMENT_BYTES} bytes.`);
  }
  const { conversation } = await requireMembership(env, caller, conversationId);
  assertOpen(conversation);
  await requireRegisteredDevice(env, caller);
  await limit(env.ATTACH_LIMITER, `attach:${caller.accountId}:${String(caller.deviceId)}`);

  const id = randomId("a");
  const token = newToken();
  const now = Date.now();
  const expiresAt = now + URL_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO attachments (id, conversation_id, uploader_account, size, state, upload_token_hash, upload_expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, 'reserved', ?5, ?6, ?7)`,
  )
    .bind(id, conversationId, caller.accountId, size, await sha256Hex(token), expiresAt, now)
    .run();
  const origin = new URL(request.url).origin;
  return json(
    {
      attachmentId: id,
      uploadUrl: `${origin}/v1/attachments/${id}/upload?token=${token}`,
      expiresAt: new Date(expiresAt).toISOString(),
    },
    201,
  );
}

export async function handleUpload(request: Request, env: Env, attachmentId: string): Promise<Response> {
  if (!ATTACHMENT_ID.test(attachmentId)) throw gone();
  const hash = await sha256Hex(tokenParam(request));
  const row = await env.DB.prepare("SELECT size FROM attachments WHERE id = ?1 AND upload_token_hash = ?2")
    .bind(attachmentId, hash)
    .first<{ size: number }>();
  if (!row) throw gone();
  const length = request.headers.get("content-length");
  if (length === null) throw new HttpError(411, "length_required", "Send Content-Length.");
  if (Number(length) > row.size) throw new HttpError(413, "payload_too_large", "Larger than the reserved size.");
  if (Number(length) !== row.size || !request.body) throw invalid("The body must be exactly the reserved size.");
  // Claim the URL: only one request can use it.
  const claimed = await env.DB.prepare(
    `UPDATE attachments SET state = 'uploading', upload_token_hash = NULL
     WHERE id = ?1 AND upload_token_hash = ?2 AND state = 'reserved' AND upload_expires_at > ?3`,
  )
    .bind(attachmentId, hash, Date.now())
    .run();
  if (claimed.meta.changes !== 1) throw gone();
  const object = await env.ATTACHMENTS.put(attachmentId, request.body, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  if (object.size !== row.size) {
    await env.ATTACHMENTS.delete(attachmentId);
    throw invalid("The body must be exactly the reserved size.");
  }
  await env.DB.prepare("UPDATE attachments SET state = 'uploaded', uploaded_at = ?2 WHERE id = ?1")
    .bind(attachmentId, Date.now())
    .run();
  return empty();
}

export async function handleGetAttachment(
  request: Request,
  env: Env,
  caller: Caller,
  attachmentId: string,
): Promise<Response> {
  if (!ATTACHMENT_ID.test(attachmentId)) throw notFound("No such attachment.");
  const row = await env.DB.prepare("SELECT conversation_id, size FROM attachments WHERE id = ?1 AND state = 'uploaded'")
    .bind(attachmentId)
    .first<{ conversation_id: string; size: number }>();
  if (!row) throw notFound("No such attachment.");
  try {
    await requireMembership(env, caller, row.conversation_id);
  } catch {
    throw notFound("No such attachment.");
  }
  await limit(env.ATTACH_LIMITER, `attach:${caller.accountId}:${String(caller.deviceId)}`);
  const token = newToken();
  const expiresAt = Date.now() + URL_TTL_MS;
  await env.DB.prepare("INSERT INTO attachment_downloads (token_hash, attachment_id, expires_at) VALUES (?1, ?2, ?3)")
    .bind(await sha256Hex(token), attachmentId, expiresAt)
    .run();
  const origin = new URL(request.url).origin;
  return json({
    attachmentId,
    size: row.size,
    downloadUrl: `${origin}/v1/attachments/${attachmentId}/download?token=${token}`,
    expiresAt: new Date(expiresAt).toISOString(),
  });
}

export async function handleDownload(request: Request, env: Env, attachmentId: string): Promise<Response> {
  if (!ATTACHMENT_ID.test(attachmentId)) throw gone();
  const hash = await sha256Hex(tokenParam(request));
  const used = await env.DB.prepare(
    "DELETE FROM attachment_downloads WHERE token_hash = ?1 AND attachment_id = ?2 AND expires_at > ?3 RETURNING 1 AS ok",
  )
    .bind(hash, attachmentId, Date.now())
    .first();
  if (!used) throw gone();
  const object = await env.ATTACHMENTS.get(attachmentId);
  if (!object) throw gone();
  return new Response(object.body, {
    headers: {
      ...SECURITY_HEADERS,
      "content-type": "application/octet-stream",
      "content-length": String(object.size),
    },
  });
}

// Retention: a conversation's attachments go with it.
export async function purgeConversationAttachments(env: Env, conversationId: string): Promise<void> {
  for (;;) {
    const rows = await env.DB.prepare("SELECT id FROM attachments WHERE conversation_id = ?1 LIMIT 500")
      .bind(conversationId)
      .all<{ id: string }>();
    const ids = rows.results.map((r) => r.id);
    if (ids.length === 0) return;
    await env.ATTACHMENTS.delete(ids);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM attachment_downloads WHERE attachment_id IN (SELECT value FROM json_each(?1))").bind(
        JSON.stringify(ids),
      ),
      env.DB.prepare("DELETE FROM attachments WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(ids)),
    ]);
  }
}

// Hourly: expired download tokens, and reservations never (completely) uploaded.
export async function purgeAbandonedAttachments(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM attachment_downloads WHERE expires_at <= ?1").bind(now).run();
  const rows = await env.DB.prepare(
    "SELECT id FROM attachments WHERE state IN ('reserved', 'uploading') AND created_at < ?1 LIMIT 1000",
  )
    .bind(now - ABANDONED_MS)
    .all<{ id: string }>();
  const ids = rows.results.map((r) => r.id);
  if (ids.length === 0) return;
  await env.ATTACHMENTS.delete(ids);
  await env.DB.prepare("DELETE FROM attachments WHERE id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(ids))
    .run();
}
