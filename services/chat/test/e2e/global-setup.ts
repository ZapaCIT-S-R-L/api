// The fake account service for the e2e run: one ES256 key for all test files (the Worker caches the key set), its
// public half served on 127.0.0.1:8789 (not when LIVE), the private half handed to the tests.
import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    accountKey: JWK;
  }
}

let server: Server | undefined;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const kid = `e2e-${Date.now().toString(36)}`;
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
  project.provide("accountKey", { ...(await exportJWK(privateKey)), kid, alg: "ES256" });
  if (process.env.LIVE !== "1") {
    server = createServer((req, res) => {
      const ok = req.url === "/.well-known/jwks.json";
      res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { keys: [jwk] } : {}));
    });
    await new Promise<void>((resolve) => server?.listen(Number(process.env.JWKS_PORT ?? 8789), "127.0.0.1", resolve));
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
