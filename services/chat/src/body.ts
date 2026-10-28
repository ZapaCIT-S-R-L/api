// Request bodies: JSON objects only, capped in size, validated field by field. Unknown fields are rejected.
import { HttpError, invalid } from "./http";

export const MAX_JSON_BYTES = 16 * 1024;

export async function readJson(request: Request, maxBytes = MAX_JSON_BYTES): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new HttpError(415, "unsupported_media_type", "Send Content-Type: application/json.");
  }
  const bytes = await readCapped(request, maxBytes);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw invalid("The body is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("Send a JSON object.");
  return value as Record<string, unknown>;
}

const tooLarge = (maxBytes: number) => new HttpError(413, "payload_too_large", `The body is over ${maxBytes} bytes.`);

// Reads the body but stops as soon as it passes the limit (chunked bodies have no Content-Length).
export async function readCapped(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length") ?? "0") > maxBytes) throw tooLarge(maxBytes);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function onlyFields(body: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw invalid(`Unknown field: ${extra.join(", ")}.`);
}

export const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const CONVERSATION_ID = /^c_[A-Za-z0-9_-]{22}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isDeviceId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 127;
}

export function isRegistrationId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 16383;
}

// A random id: prefix + 22 base64url characters (128 bits).
export function randomId(prefix: string): string {
  return `${prefix}_${base64url(crypto.getRandomValues(new Uint8Array(16)))}`;
}

export function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
