// Shared helpers for the end-to-end tests. LIVE=1 means a deployed environment: no test-only setup is possible there.
// CALLS_URL, not BASE_URL: Vite sets process.env.BASE_URL itself.
export const CALLS_URL = (process.env.CALLS_URL ?? "http://127.0.0.1:8797").replace(/\/$/, "");
if (!/^https?:\/\/[^/]+$/.test(CALLS_URL))
  throw new Error(`CALLS_URL must be an absolute http(s) origin, got "${CALLS_URL}"`);
export const LIVE = process.env.LIVE === "1";

export function calls(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${CALLS_URL}${path}`, { redirect: "manual", ...init });
}
