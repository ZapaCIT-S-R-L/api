// Sign-in end to end over HTTP. Locally (wrangler dev started with APPLE_JWKS_URL / GOOGLE_JWKS_URL pointing at
// the JWKS server below, see the e2e job in ci.yml) the full flow runs with test keys. Against a deployed
// environment (LIVE=1) only the checks that need no valid token run: the real Apple and Google keys reject ours.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, bodyOf, LIVE } from "./base";

export const JWKS_PORT = Number(process.env.JWKS_PORT ?? 8788);
const GOOGLE_AUDIENCE = "000000000000-zapakidlocaltest.apps.googleusercontent.com";

interface Signer {
  jwk: JWK;
  sign(claims: JWTPayload, exp?: number): Promise<string>;
}

async function signer(kid: string): Promise<Signer> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  return {
    jwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" },
    sign: (claims, exp) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuedAt()
        .setExpirationTime(exp ?? "10m")
        .sign(privateKey),
  };
}

const run = Date.now().toString(36);
let apple: Signer;
let google: Signer;
let server: Server | undefined;

beforeAll(async () => {
  apple = await signer(`e2e-apple-${run}`);
  google = await signer(`e2e-google-${run}`);
  if (LIVE) return;
  server = createServer((req, res) => {
    const keys = req.url === "/apple" ? [apple.jwk] : req.url === "/google" ? [google.jwk] : null;
    res.writeHead(keys ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(keys ? { keys } : {}));
  });
  await new Promise<void>((resolve) => server?.listen(JWKS_PORT, "127.0.0.1", resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (server)
      server.close(() => {
        resolve();
      });
    else resolve();
  });
});

const adult = { availability: "shared", source: "apple_declared_age_range", lowerBound: 18, upperBound: null };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  api(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
// A fresh one-time nonce from the API; the token carries its SHA-256 (hex).
async function freshNonce(): Promise<{ nonce: string; hash: string }> {
  const res = await api("/v1/auth/nonce", { method: "POST" });
  expect(res.status).toBe(200);
  const { nonce } = await bodyOf<{ nonce: string }>(res);
  return { nonce, hash: createHash("sha256").update(nonce).digest("hex") };
}

// An Apple sign-in body for a fresh nonce.
async function appleSignIn(claims: JWTPayload = {}, ageRange: object = adult, exp?: number) {
  const { nonce, hash } = await freshNonce();
  const base = { iss: "https://appleid.apple.com", aud: "com.zapacit.cuzaai", sub: `e2e-${run}`, nonce: hash };
  return { identityToken: await apple.sign({ ...base, ...claims }, exp), ageRange, nonce };
}

interface SignIn {
  session: { token: string };
  parent: { id: string };
  newAccount: boolean;
}

describe("sign-in, everywhere (no valid token needed)", () => {
  it("POST /v1/auth/nonce issues a nonce", async () => {
    expect((await freshNonce()).nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("a token signed by a key Apple doesn't have → 401", async () => {
    const res = await post("/v1/auth/apple", await appleSignIn());
    if (LIVE) expect(res.status).toBe(401);
    else expect([200, 401]).toContain(res.status);
  });

  it("garbage token → 401 invalid_token", async () => {
    const { nonce } = await freshNonce();
    const res = await post("/v1/auth/google", { idToken: "a.b.c", ageRange: adult, nonce });
    expect(res.status).toBe(401);
    expect((await bodyOf<{ error: { code: string } }>(res)).error.code).toBe("invalid_token");
  });

  it("missing fields → 400", async () => {
    expect((await post("/v1/auth/apple", { ageRange: adult })).status).toBe(400);
  });

  it("GET /v1/me without a session → 401 Bearer", async () => {
    const res = await api("/v1/me");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("logout without a session → 401", async () => {
    expect((await api("/v1/auth/logout", { method: "POST" })).status).toBe(401);
  });

  it("an unknown session token → 401", async () => {
    const res = await api("/v1/me", { headers: { authorization: `Bearer zks_${"B".repeat(43)}` } });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(LIVE)("sign-in flow with test keys (local only)", () => {
  it("Apple: sign in, /me, logout, /me again", async () => {
    const res = await post("/v1/auth/apple", { ...(await appleSignIn()), displayName: "E2E" });
    expect(res.status).toBe(200);
    const { session, parent } = await bodyOf<SignIn>(res);
    const auth = { authorization: `Bearer ${session.token}` };

    const me = await api("/v1/me", { headers: auth });
    expect(me.status).toBe(200);
    expect((await bodyOf<{ id: string }>(me)).id).toBe(parent.id);

    expect((await api("/v1/auth/logout", { method: "POST", headers: auth })).status).toBe(204);
    expect((await api("/v1/me", { headers: auth })).status).toBe(401);
  });

  it("Google: sign in", async () => {
    const { nonce, hash } = await freshNonce();
    const idToken = await google.sign({
      nonce: hash,
      iss: "https://accounts.google.com",
      aud: GOOGLE_AUDIENCE,
      sub: `e2e-${run}`,
      email: `e2e-${run}@example.com`,
      email_verified: true,
    });
    const ageRange = {
      availability: "shared",
      source: "google_play_age_signals",
      lowerBound: 18,
      upperBound: null,
      platformStatus: "VERIFIED",
    };
    expect((await post("/v1/auth/google", { idToken, ageRange, nonce })).status).toBe(200);
  });

  it("wrong audience → 401", async () => {
    const res = await post("/v1/auth/apple", await appleSignIn({ aud: "com.other" }));
    expect(res.status).toBe(401);
  });

  it("expired → 401", async () => {
    const body = await appleSignIn({}, adult, Math.floor(Date.now() / 1000) - 300);
    expect((await post("/v1/auth/apple", body)).status).toBe(401);
  });

  it("minor → 403", async () => {
    const ageRange = { availability: "shared", source: "apple_declared_age_range", lowerBound: 13, upperBound: 15 };
    const res = await post("/v1/auth/apple", await appleSignIn({ sub: `kid-${run}` }, ageRange));
    expect(res.status).toBe(403);
  });

  it("declined to share the age range → 403", async () => {
    const ageRange = {
      availability: "declined",
      source: "apple_declared_age_range",
      lowerBound: null,
      upperBound: null,
    };
    const res = await post("/v1/auth/apple", await appleSignIn({ sub: `declined-${run}` }, ageRange));
    expect(res.status).toBe(403);
  });

  it("Apple web flow (Android): start, callback, exchange", async () => {
    const verifier = createHash("sha256").update(`verifier-${run}`).digest("hex");
    const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
    const start = await post("/v1/auth/apple/web", { codeChallenge, codeChallengeMethod: "S256" });
    expect(start.status).toBe(200);
    const { state } = await bodyOf<{ state: string }>(start);
    const { nonce, hash } = await freshNonce();
    const idToken = await apple.sign({
      iss: "https://appleid.apple.com",
      aud: "ro.zapakid.signin.local",
      sub: `web-${run}`,
      nonce: hash,
    });
    const callback = await api("/v1/auth/apple/callback", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state, id_token: idToken, code: "apple" }).toString(),
    });
    expect(callback.status).toBe(303);
    const fragment = new URLSearchParams((callback.headers.get("location") ?? "").split("#")[1]);
    expect(fragment.get("state")).toBe(state);
    const code = fragment.get("code") ?? "";
    const exchange = await post("/v1/auth/apple/exchange", { code, codeVerifier: verifier, nonce, ageRange: adult });
    expect(exchange.status).toBe(200);
  });

  it("a replayed token and nonce → 401", async () => {
    const body = await appleSignIn({ sub: `replay-${run}` });
    expect((await post("/v1/auth/apple", body)).status).toBe(200);
    expect((await post("/v1/auth/apple", body)).status).toBe(401);
  });
});
