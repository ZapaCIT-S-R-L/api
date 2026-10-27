// scripts/chat-token-key.js makes the throwaway chat token signing key of local e2e runs (wrangler dev --var). It
// never prints a key to a terminal. Deployed keys come from the bootstrap-secrets workflow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { calculateJwkThumbprint, importJWK, SignJWT, jwtVerify } from "jose";

const script = new URL("../../scripts/chat-token-key.js", import.meta.url).pathname;

test("prints a private P-256 JWK with its thumbprint as kid, when piped", async () => {
  const out = execFileSync(process.execPath, [script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const jwk = JSON.parse(out);
  assert.equal(jwk.kty, "EC");
  assert.equal(jwk.crv, "P-256");
  assert.equal(jwk.alg, "ES256");
  assert.equal(jwk.use, "sig");
  assert.ok(jwk.d, "private part");
  assert.equal(jwk.kid, await calculateJwkThumbprint({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }));
  const jwt = await new SignJWT({}).setProtectedHeader({ alg: "ES256" }).sign(await importJWK(jwk, "ES256"));
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  await jwtVerify(jwt, await importJWK(publicJwk, "ES256"));
});

test("a new key every run", () => {
  const run = () => JSON.parse(execFileSync(process.execPath, [script], { encoding: "utf8" })).d;
  assert.notEqual(run(), run());
});

test("refuses to print the key to a terminal", () => {
  const res = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, CHAT_TOKEN_KEY_TTY: "1" },
  });
  assert.notEqual(res.status, 0);
  assert.equal(res.stdout, "");
  assert.match(res.stderr, /pipe/);
});
