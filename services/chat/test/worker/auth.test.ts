// Chat tokens: ES256 from the account service's JWKS, this audience, at most 15 minutes, sub/dev/role.
import { beforeEach, describe, expect, it } from "vitest";
import { as, call, claims, makeIssuer, MUM, seedFamilies, stubJwks, type Issuer, type JwksStub } from "./helpers";

let issuer: Issuer;
let jwks: JwksStub;

beforeEach(async () => {
  issuer = await makeIssuer();
  jwks = stubJwks(issuer);
  await seedFamilies();
});

async function status(token: string): Promise<number> {
  return (await as(token, "/v1/conversations")).status;
}

describe("chat token", () => {
  it("a valid token works", async () => {
    expect(await status(await issuer.sign(claims(MUM)))).toBe(200);
  });

  it("no token: 401 with WWW-Authenticate", async () => {
    const res = await call("/v1/conversations");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("garbage token: 401", async () => {
    expect(await status("a.b.c")).toBe(401);
  });

  it("wrong audience (another service's token): 401", async () => {
    expect(await status(await issuer.sign(claims(MUM, { aud: "calls.zapakid.test" })))).toBe(401);
  });

  it("wrong issuer: 401", async () => {
    expect(await status(await issuer.sign(claims(MUM, { iss: "evil.example" })))).toBe(401);
  });

  it("expired: 401", async () => {
    const iat = Math.floor(Date.now() / 1000) - 1000;
    expect(await status(await issuer.sign(claims(MUM), { iat, lifetime: 600 }))).toBe(401);
  });

  it("lives longer than 15 minutes: 401", async () => {
    expect(await status(await issuer.sign(claims(MUM), { lifetime: 901 }))).toBe(401);
    expect(await status(await issuer.sign(claims(MUM), { lifetime: 900 }))).toBe(200);
  });

  it("signed by a key the account service doesn't publish: 401", async () => {
    const other = await makeIssuer(issuer.kid);
    expect(await status(await other.sign(claims(MUM)))).toBe(401);
  });

  it("HS256 / alg confusion is refused", async () => {
    const { SignJWT } = await import("jose");
    const token = await new SignJWT(claims(MUM))
      .setProtectedHeader({ alg: "HS256", kid: issuer.kid })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("x".repeat(32)));
    expect(await status(token)).toBe(401);
  });

  it("missing or invalid sub, dev or role: 401", async () => {
    for (const bad of [{ sub: "" }, { dev: 0 }, { dev: 128 }, { dev: "x" }, { role: "admin" }, { role: undefined }]) {
      expect(await status(await issuer.sign(claims(MUM, bad))), JSON.stringify(bad)).toBe(401);
    }
  });

  it("dev as a decimal string is accepted", async () => {
    expect(await status(await issuer.sign(claims(MUM, { dev: "2" })))).toBe(200);
  });

  it("the key set is cached", async () => {
    const token = await issuer.sign(claims(MUM));
    await status(token);
    await status(token);
    expect(jwks.calls).toBe(1);
  });

  it("account service keys unreachable on first use: 503 auth_unavailable", async () => {
    jwks.fail = true;
    const res = await as(await issuer.sign(claims(MUM)), "/v1/conversations");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "auth_unavailable" } });
  });

  it("keeps working on cached keys while the account service is down", async () => {
    const token = await issuer.sign(claims(MUM));
    expect(await status(token)).toBe(200);
    jwks.fail = true;
    expect(await status(token)).toBe(200);
  });
});
