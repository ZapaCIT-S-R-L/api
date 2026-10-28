// Outbound URLs from config: https always, plain http only to loopback (local development and the e2e fakes).
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function safeUrl(value: string | undefined): URL | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url;
  return null;
}
