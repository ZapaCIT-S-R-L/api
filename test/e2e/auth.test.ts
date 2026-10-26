// Sign-in end to end over HTTP. Locally (wrangler dev started with APPLE_JWKS_URL / GOOGLE_JWKS_URL pointing at
// the JWKS server below, see the e2e job in ci.yml) the full flow runs with test keys. Against a deployed
// environment (LIVE=1) only the checks that need no valid token run: the real Apple and Google keys reject ours.
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

const adult = { source: "apple_declared_age_range", lowerBound: 18, upperBound: null };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  api(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const appleToken = (claims: JWTPayload = {}, exp?: number) =>
  apple.sign({ iss: "https://appleid.apple.com", aud: "com.zapacit.cuzaai", sub: `e2e-${run}`, ...claims }, exp);

interface SignIn {
  session: { token: string };
  parent: { id: string };
  newAccount: boolean;
}

describe("sign-in, everywhere (no valid token needed)", () => {
  it("a token signed by a key Apple doesn't have → 401", async () => {
    const res = await post("/v1/auth/apple", { identityToken: await appleToken(), ageRange: adult });
    if (LIVE) expect(res.status).toBe(401);
    else expect([200, 401]).toContain(res.status);
  });

  it("garbage token → 401 invalid_token", async () => {
    const res = await post("/v1/auth/google", { idToken: "a.b.c", ageRange: adult });
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
    const res = await post("/v1/auth/apple", {
      identityToken: await appleToken(),
      ageRange: adult,
      displayName: "E2E",
    });
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
    const idToken = await google.sign({
      iss: "https://accounts.google.com",
      aud: GOOGLE_AUDIENCE,
      sub: `e2e-${run}`,
      email: `e2e-${run}@example.com`,
      email_verified: true,
    });
    const ageRange = {
      source: "google_play_age_signals",
      lowerBound: 18,
      upperBound: null,
      platformStatus: "VERIFIED",
    };
    expect((await post("/v1/auth/google", { idToken, ageRange })).status).toBe(200);
  });

  it("wrong audience → 401", async () => {
    const res = await post("/v1/auth/apple", {
      identityToken: await appleToken({ aud: "com.other" }),
      ageRange: adult,
    });
    expect(res.status).toBe(401);
  });

  it("expired → 401", async () => {
    const token = await appleToken({}, Math.floor(Date.now() / 1000) - 300);
    expect((await post("/v1/auth/apple", { identityToken: token, ageRange: adult })).status).toBe(401);
  });

  it("minor → 403", async () => {
    const ageRange = { source: "apple_declared_age_range", lowerBound: 13, upperBound: 15 };
    const res = await post("/v1/auth/apple", { identityToken: await appleToken({ sub: `kid-${run}` }), ageRange });
    expect(res.status).toBe(403);
  });
});
