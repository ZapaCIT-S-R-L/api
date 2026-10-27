// Request bodies: JSON objects only, at most 64 KiB (an SDP offer for a few tracks fits easily), validated field by
// field. Unknown fields are rejected.
export const MAX_BODY_BYTES = 64 * 1024;

export class BadRequest extends Error {
  constructor(
    readonly status: 400 | 413 | 415,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const invalid = (message: string) => new BadRequest(400, "invalid_request", message);

// The parsed body; an empty body is {} when `optional`.
export async function readJson(request: Request, optional = false): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new BadRequest(413, "payload_too_large", "The body is over 64 KiB.");
  const text = await readCapped(request);
  if (text === "" && optional) return {};
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new BadRequest(415, "unsupported_media_type", "Send Content-Type: application/json.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid("The body is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("Send a JSON object.");
  return value as Record<string, unknown>;
}

async function readCapped(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new BadRequest(413, "payload_too_large", "The body is over 64 KiB.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function onlyFields(body: Record<string, unknown>, allowed: string[], where: string): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw invalid(`Unknown field in ${where}: ${extra.join(", ")}.`);
}

export const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export function id(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value))
    throw invalid(`${field} must be 1-128 letters, digits or _.:-`);
  return value;
}
