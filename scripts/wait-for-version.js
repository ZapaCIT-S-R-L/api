// Waits until <url>/health answers 200 with the given version, so the post-deploy e2e tests run against the new
// Worker (a fresh custom domain can answer 500 for a minute, and old versions linger at some locations).
// CLI (deploy workflows): node scripts/wait-for-version.js https://api-staging.zapakid.ro v1.2.3
import { fileURLToPath } from "node:url";

export async function waitForVersion(url, version, { timeoutMs = 180_000, intervalMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(10_000) });
      const body = await res.text();
      if (res.status === 200 && JSON.parse(body).version === version) return;
      last = `${res.status} ${body.slice(0, 200)}`;
    } catch (e) {
      last = String(e);
    }
    if (Date.now() >= deadline) throw new Error(`${url}/health never reported ${version}; last answer: ${last}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [url, version] = process.argv.slice(2);
  await waitForVersion(url, version);
  console.log(`${url} serves ${version}`);
}
