// Makes a new chat token signing key: a private P-256 JWK (ES256) with its RFC 7638 thumbprint as kid, on stdout.
// Only for piping into `wrangler secret put` (scripts/set-chat-token-key.sh); it refuses to print to a terminal.
// CHAT_TOKEN_KEY_TTY=1 makes it behave as if stdout were a terminal (tests).
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";

if (process.stdout.isTTY || process.env.CHAT_TOKEN_KEY_TTY === "1") {
  console.error(
    "Refusing to print a private key to the terminal: pipe it into wrangler (scripts/set-chat-token-key.sh).",
  );
  process.exit(1);
}

const { privateKey } = await generateKeyPair("ES256", { extractable: true });
const jwk = await exportJWK(privateKey);
const kid = await calculateJwkThumbprint({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
process.stdout.write(JSON.stringify({ ...jwk, kid, alg: "ES256", use: "sig" }));
