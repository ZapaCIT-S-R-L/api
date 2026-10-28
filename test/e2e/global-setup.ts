// Runs once before all e2e files: test Apple and Google signing keys for this run, and (locally) the JWKS server
// on 127.0.0.1:8788 that wrangler dev is pointed at (APPLE_JWKS_URL / GOOGLE_JWKS_URL). One key set for every file,
// so the Worker's JWKS cache (refetch at most every 5 minutes) never sees an unknown key id mid-run.
import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    testKeys: { apple: { kid: string; privateJwk: JWK }; google: { kid: string; privateJwk: JWK } };
  }
}

const JWKS_PORT = Number(process.env.JWKS_PORT ?? 8788);

async function key(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  return {
    kid,
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" },
    privateJwk: { ...(await exportJWK(privateKey)), kid, alg: "RS256" },
  };
}

let server: Server | undefined;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const run = Date.now().toString(36);
  const apple = await key(`e2e-apple-${run}`);
  const google = await key(`e2e-google-${run}`);
  project.provide("testKeys", {
    apple: { kid: apple.kid, privateJwk: apple.privateJwk },
    google: { kid: google.kid, privateJwk: google.privateJwk },
  });
  if (process.env.LIVE !== "1") {
    server = createServer((req, res) => {
      const keys = req.url === "/apple" ? [apple.publicJwk] : req.url === "/google" ? [google.publicJwk] : null;
      res.writeHead(keys ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(keys ? { keys } : {}));
    });
    await new Promise<void>((resolve) => server?.listen(JWKS_PORT, "127.0.0.1", resolve));
  }
  return () =>
    new Promise<void>((resolve) => {
      if (server)
        server.close(() => {
          resolve();
        });
      else resolve();
    });
}
