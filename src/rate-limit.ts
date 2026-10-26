// Rate limiting for the unauthenticated auth endpoints, per client address and Cloudflare location (Workers rate
// limiting binding AUTH_LIMITER, limits in wrangler.jsonc). CF-Connecting-IP is set by Cloudflare, not the client.
import type { Env } from "./env";
import { error } from "./http";

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4(text: string): string | null {
  const m = IPV4.exec(text);
  if (!m || m.slice(1).some((part) => Number(part) > 255)) return null;
  return m.slice(1).map(Number).join(".");
}

// The eight 16-bit groups of an IPv6 address, or null.
function ipv6Groups(text: string): number[] | null {
  if (!/^[0-9a-fA-F:]+$/.test(text) || text.split("::").length > 2) return null;
  const [head = "", tail] = text.split("::");
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right];
  if (groups.some((g) => g.length === 0 || g.length > 4)) return null;
  return groups.map((g) => parseInt(g, 16));
}

// IPv4 as is; IPv6 by its /64 (one customer network), so rotating addresses inside it doesn't help.
export function clientKey(ip: string | null): string {
  if (!ip) return "unknown";
  const v4 = ipv4(ip);
  if (v4) return `ip4:${v4}`;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) {
    const inner = ipv4(mapped[1]);
    if (inner) return `ip4:${inner}`;
  }
  const groups = ipv6Groups(ip);
  if (!groups) return "unknown";
  return `ip6:${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}`;
}

// A 429 response if this client is over the auth limit, else null.
export async function limitAuth(request: Request, env: Env): Promise<Response | null> {
  const { success } = await env.AUTH_LIMITER.limit({ key: clientKey(request.headers.get("cf-connecting-ip")) });
  if (success) return null;
  return error(429, "rate_limited", "Too many sign-in attempts. Try again in a minute.", { "retry-after": "60" });
}
