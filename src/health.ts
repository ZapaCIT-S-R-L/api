// GET /health: liveness plus a config check. Problems name the binding or variable only, never its value.
import type { Env } from "./env";
import { json } from "./http";
import { parseCredentials } from "./play-integrity";
import { ttlSeconds } from "./sessions";

// The types say every field is there; a deployed environment may still lack one (bindings and vars are per
// environment in wrangler.jsonc), so check what is actually present.
function problems(env: Env): string[] {
  const present: Partial<Env> = env;
  const found: string[] = [];
  if (!present.DB) found.push("DB binding missing");
  if (!present.AUTH_LIMITER) found.push("AUTH_LIMITER binding missing");
  if (!present.APPLE_AUDIENCES || present.APPLE_AUDIENCES.split(",").every((id) => id.trim() === "")) {
    found.push("APPLE_AUDIENCES empty");
  }
  if (!/^https:\/\/[a-z0-9.-]+\/\S*$/.test(present.APPLE_WEB_REDIRECT_URL ?? "")) {
    found.push("APPLE_WEB_REDIRECT_URL not an https URL");
  }
  try {
    ttlSeconds(env);
  } catch {
    found.push("SESSION_TTL_SECONDS invalid");
  }
  if (!["required", "allowlist", "optional"].includes(present.ATTESTATION_POLICY ?? "")) {
    found.push("ATTESTATION_POLICY not required, allowlist or optional");
  }
  if (!present.PLAY_PACKAGE_NAME) found.push("PLAY_PACKAGE_NAME empty");
  if (!/^[A-Z0-9]{10}\.[a-z0-9.-]+$/i.test(present.APP_ATTEST_APP_ID ?? "")) found.push("APP_ATTEST_APP_ID invalid");
  if (!present.APP_ATTEST_ENVIRONMENTS?.trim()) found.push("APP_ATTEST_ENVIRONMENTS empty");
  // Only "required" can't work without them; under "allowlist" (staging) a missing service account makes attested
  // requests answer 503 until it is set, which shouldn't fail every deploy.
  if (present.ATTESTATION_POLICY === "required") {
    if (!parseCredentials(present.PLAY_INTEGRITY_CREDENTIALS))
      found.push("PLAY_INTEGRITY_CREDENTIALS missing or invalid");
    if (!present.PLAY_CERT_SHA256?.trim()) found.push("PLAY_CERT_SHA256 empty");
  }
  return found;
}

export async function handleHealth(_request: Request, env: Env): Promise<Response> {
  const found = problems(env);
  if (!found.includes("DB binding missing")) {
    try {
      await env.DB.prepare("SELECT 1").first();
    } catch {
      found.push("DB unreachable");
    }
  }
  if (found.length > 0) {
    console.error(JSON.stringify({ msg: "misconfigured", problems: found }));
    return json({ status: "misconfigured", version: env.VERSION, problems: found }, 503);
  }
  return json({ status: "ok", version: env.VERSION });
}
