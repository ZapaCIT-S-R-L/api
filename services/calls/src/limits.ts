// Call limits from wrangler.jsonc vars, checked once: a bad value fails /health instead of a call.
import type { Env } from "./env";

export interface Limits {
  maxParticipants: number;
  ringTimeoutSeconds: number;
  maxCallSeconds: number;
  turnTtlSeconds: number;
  reconnectGraceSeconds: number;
  retentionDays: number;
}

const RULES: [keyof Limits, keyof Env, number, number][] = [
  ["maxParticipants", "MAX_PARTICIPANTS", 2, 8],
  ["ringTimeoutSeconds", "RING_TIMEOUT_SECONDS", 1, 120],
  ["maxCallSeconds", "MAX_CALL_SECONDS", 60, 6 * 3600],
  ["turnTtlSeconds", "TURN_TTL_SECONDS", 60, 3600],
  ["reconnectGraceSeconds", "RECONNECT_GRACE_SECONDS", 5, 300],
  ["retentionDays", "CALL_LOG_RETENTION_DAYS", 1, 365],
];

export class BadLimit extends Error {}

export function limits(env: Env): Limits {
  const out: Partial<Limits> = {};
  for (const [key, name, min, max] of RULES) {
    const value = Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new BadLimit(`${name} must be an integer from ${min} to ${max}`);
    }
    out[key] = value;
  }
  return out as Limits;
}

// For /health: the names of the limits that are missing or out of range.
export function limitProblems(env: Partial<Env>): string[] {
  return RULES.filter(([, name, min, max]) => {
    const value = Number(env[name]);
    return !Number.isInteger(value) || value < min || value > max;
  }).map(([, name, min, max]) => `${name} not an integer from ${min} to ${max}`);
}
