// Shared helpers for the end-to-end tests. LIVE=1 means a deployed environment: no test-only setup is possible there.
// API_URL, not BASE_URL: Vite sets process.env.BASE_URL itself.
export const API_URL = (process.env.API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
if (!/^https?:\/\/[^/]+$/.test(API_URL))
  throw new Error(`API_URL must be an absolute http(s) origin, got "${API_URL}"`);
export const LIVE = process.env.LIVE === "1";

export function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_URL}${path}`, { redirect: "manual", ...init });
}

export async function bodyOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
