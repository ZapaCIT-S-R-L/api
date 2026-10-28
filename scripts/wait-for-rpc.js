// Waits until <url>/health answers 200 and lists every given RPC method in `rpc`, so a Worker that calls those
// methods over a service binding is never deployed before the Worker that serves them (deploy-calls.yml waits for
// the chat Worker's ChatMembership.revoked, api #81). Gives up after the timeout: the deploy then fails before it
// changes anything, and re-running it once the other Worker is live is safe.
// CLI: node scripts/wait-for-rpc.js https://chat-staging.zapakid.ro member revoked
import { fileURLToPath } from "node:url";

export async function waitForRpc(url, methods, { timeoutMs = 1_800_000, intervalMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(10_000) });
      const body = await res.text();
      const rpc = res.status === 200 ? JSON.parse(body).rpc : undefined;
      if (Array.isArray(rpc) && methods.every((m) => rpc.includes(m))) return;
      last = `${res.status} ${body.slice(0, 200)}`;
    } catch (e) {
      last = String(e);
    }
    if (Date.now() >= deadline) {
      throw new Error(`${url}/health never listed rpc ${methods.join(", ")}; last answer: ${last}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [url, ...methods] = process.argv.slice(2);
  if (!url || methods.length === 0) {
    console.error("usage: node scripts/wait-for-rpc.js <url> <method>...");
    process.exit(2);
  }
  await waitForRpc(url, methods);
  console.log(`${url} serves ${methods.join(", ")}`);
}
