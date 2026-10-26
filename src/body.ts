// Request bodies: JSON only, at most 16 KiB, validated field by field. Unknown fields are rejected.
import type { AgeAvailability, AgeRange, AgeSource } from "./age";
import { NONCE_PATTERN } from "./nonces";

export const MAX_BODY_BYTES = 16 * 1024;
const MAX_TOKEN_LENGTH = 8192;

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

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new BadRequest(415, "unsupported_media_type", "Send Content-Type: application/json.");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new BadRequest(413, "payload_too_large", "The body is over 16 KiB.");
  const bytes = await readCapped(request);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw invalid("The body is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("Send a JSON object.");
  return value as Record<string, unknown>;
}

// Reads the body but stops as soon as it passes the limit (chunked bodies have no Content-Length).
async function readCapped(request: Request): Promise<Uint8Array> {
  const tooLarge = () => new BadRequest(413, "payload_too_large", "The body is over 16 KiB.");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw tooLarge();
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

// An application/x-www-form-urlencoded body (Apple's form_post), same 16 KiB cap. Null if not a form.
export async function readForm(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(type)) return null;
  return new URLSearchParams(new TextDecoder().decode(await readCapped(request)));
}

export function onlyFields(body: Record<string, unknown>, allowed: string[], where: string): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw invalid(`Unknown field in ${where}: ${extra.join(", ")}.`);
}

function token(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) throw invalid(`${field} is required.`);
  if (value.length > MAX_TOKEN_LENGTH) throw invalid(`${field} is too long.`);
  return value;
}

function bound(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 150) {
    throw invalid(`ageRange.${field} must be an integer from 0 to 150, or null.`);
  }
  return value;
}

const AVAILABILITY: AgeAvailability[] = ["shared", "declined", "unavailable"];
const SOURCES: AgeSource[] = ["apple_declared_age_range", "google_play_age_signals"];

export function parseAgeRange(value: unknown): AgeRange {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("ageRange is required.");
  const range = value as Record<string, unknown>;
  onlyFields(range, ["availability", "source", "lowerBound", "upperBound", "platformStatus"], "ageRange");
  if (!AVAILABILITY.includes(range.availability as AgeAvailability)) {
    throw invalid(`ageRange.availability must be one of ${AVAILABILITY.join(", ")}.`);
  }
  const availability = range.availability as AgeAvailability;
  if (!SOURCES.includes(range.source as AgeSource))
    throw invalid(`ageRange.source must be one of ${SOURCES.join(", ")}.`);
  if (!("lowerBound" in range) || !("upperBound" in range)) {
    throw invalid("ageRange.lowerBound and ageRange.upperBound are required (null when unknown).");
  }
  const lowerBound = bound(range.lowerBound, "lowerBound");
  const upperBound = bound(range.upperBound, "upperBound");
  if (lowerBound !== null && upperBound !== null && lowerBound > upperBound) {
    throw invalid("ageRange.lowerBound is above ageRange.upperBound.");
  }
  if (availability === "shared" && lowerBound === null && upperBound === null) {
    throw invalid("A shared ageRange needs lowerBound or upperBound.");
  }
  if (availability !== "shared" && (lowerBound !== null || upperBound !== null)) {
    throw invalid(`A ${availability} ageRange has no bounds (null).`);
  }
  let platformStatus: string | null = null;
  if (range.platformStatus !== undefined) {
    if (typeof range.platformStatus !== "string" || !/^[A-Za-z_]{1,40}$/.test(range.platformStatus)) {
      throw invalid("ageRange.platformStatus must be 1-40 letters or underscores.");
    }
    platformStatus = range.platformStatus;
  }
  return { availability, source: range.source as AgeSource, lowerBound, upperBound, platformStatus };
}

export function nonce(body: Record<string, unknown>): string {
  if (typeof body.nonce !== "string" || !NONCE_PATTERN.test(body.nonce)) {
    throw invalid("nonce is required: the value from POST /v1/auth/nonce.");
  }
  return body.nonce;
}

export interface SignInRequest {
  token: string;
  nonce: string;
  ageRange: AgeRange;
  displayName: string | null;
}

export function appleSignIn(body: Record<string, unknown>): SignInRequest {
  onlyFields(body, ["identityToken", "ageRange", "nonce", "displayName"], "the body");
  let displayName: string | null = null;
  if (body.displayName !== undefined && body.displayName !== null) {
    if (typeof body.displayName !== "string" || body.displayName.length > 100) {
      throw invalid("displayName must be a string of at most 100 characters.");
    }
    displayName = body.displayName.trim() || null;
  }
  return {
    token: token(body, "identityToken"),
    nonce: nonce(body),
    ageRange: parseAgeRange(body.ageRange),
    displayName,
  };
}

export function googleSignIn(body: Record<string, unknown>): SignInRequest {
  onlyFields(body, ["idToken", "ageRange", "nonce"], "the body");
  return {
    token: token(body, "idToken"),
    nonce: nonce(body),
    ageRange: parseAgeRange(body.ageRange),
    displayName: null,
  };
}
