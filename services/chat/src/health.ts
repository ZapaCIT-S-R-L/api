// GET /health: liveness plus a config check. Problems name the binding or variable only, never its value.
import type { Env } from "./env";
import { json } from "./http";
import { allowedJwksUrl } from "./jwks";

function problems(env: Env): string[] {
  const present: Partial<Env> = env;
  const found: string[] = [];
  if (!present.DB) found.push("DB binding missing");
  if (!present.CREATE_LIMITER) found.push("CREATE_LIMITER binding missing");
  if (!present.TOKEN_ISSUER) found.push("TOKEN_ISSUER empty");
  if (!present.TOKEN_AUDIENCE) found.push("TOKEN_AUDIENCE empty");
  if (!allowedJwksUrl(present.ACCOUNT_JWKS_URL ?? "")) found.push("ACCOUNT_JWKS_URL not an https URL");
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
