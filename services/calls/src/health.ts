// GET /health: liveness plus a config check. Problems name the binding or variable only, never its value.
import type { Env } from "./env";
import { json } from "./http";
import { safeUrl } from "./urls";

// The types say every field is there; a deployed environment may still lack one, so check what is present.
export function problems(env: Env): string[] {
  const present: Partial<Env> = env;
  const found: string[] = [];
  if (!present.DB) found.push("DB binding missing");
  if (!safeUrl(present.ACCOUNT_JWKS_URL)) found.push("ACCOUNT_JWKS_URL not https (or http on loopback)");
  if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(present.TOKEN_ISSUER ?? "")) found.push("TOKEN_ISSUER not an origin");
  if (!present.TOKEN_AUDIENCE?.trim()) found.push("TOKEN_AUDIENCE empty");
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
