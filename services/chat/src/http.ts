// JSON responses and errors. Every response is private and never cached.
export const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...headers },
  });
}

export function empty(status = 204): Response {
  return new Response(null, { status, headers: SECURITY_HEADERS });
}

export function error(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return json({ error: { code, message } }, status, headers);
}

// Thrown by handlers for a client error; index.ts turns it into the JSON error response.
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }

  response(): Response {
    return json({ error: { code: this.code, message: this.message }, ...this.extra }, this.status, this.headers);
  }
}

export const invalid = (message: string) => new HttpError(400, "invalid_request", message);
export const notFound = (what = "No such conversation.") => new HttpError(404, "not_found", what);
export const notAllowed = (message: string) => new HttpError(403, "not_allowed", message);

// True for a request from this machine (wrangler dev): only then are the local test hooks served.
export function isLoopback(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
}
