// Chat tokens: ES256 from the account service's JWKS, this audience, at most 15 minutes, sub/dev/role.
import { beforeEach, describe, expect, it } from "vitest";
import { noRooms } from "../../src/rooms";
import {
  ALEX,
  apply,
  as,
  call,
  claims,
  DAD,
  makeIssuer,
  MUM,
  seedFamilies,
  stubJwks,
  type Issuer,
  type JwksStub,
} from "./helpers";

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
    expect(await status(await issuer.sign(claims(MUM, { aud: "calls.localhost" })))).toBe(401);
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

  // api #81: logout-all revokes the chat tokens issued before the account's new session epoch.
  describe("session epoch (sep)", () => {
    it("without a revocation, any sep (or none) works; a malformed one is refused", async () => {
      expect(await status(await issuer.sign(claims(MUM)))).toBe(200);
      expect(await status(await issuer.sign(claims(MUM, { sep: 0 })))).toBe(200);
      expect(await status(await issuer.sign(claims(MUM, { sep: 7 })))).toBe(200);
      for (const sep of [-1, 1.5, "1", null, {}]) {
        expect(await status(await issuer.sign(claims(MUM, { sep }))), JSON.stringify(sep)).toBe(401);
      }
    });

    it("after account.sessions_revoked, tokens below the epoch (or without sep) are refused, others work", async () => {
      await apply(noRooms, { type: "account.sessions_revoked", accountId: MUM, epoch: 2 });
      const res = await as(await issuer.sign(claims(MUM, { sep: 1 })), "/v1/conversations");
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("unauthorized");
      expect(body.error.message).toMatch(/revoked/);
      expect(await status(await issuer.sign(claims(MUM)))).toBe(401);
      expect(await status(await issuer.sign(claims(MUM, { sep: 2 })))).toBe(200);
      expect(await status(await issuer.sign(claims(MUM, { sep: 3 })))).toBe(200);
      // Other accounts are not affected.
      expect(await status(await issuer.sign(claims(DAD, { sep: 0 })))).toBe(200);
    });
  });

  // api #92: a removed device (a parent revoked a kid's phone, the kid signed out, logout-all with removeDevices) is
  // tombstoned by device.removed; tokens issued for it before the removal are refused on every route.
  describe("removed device", () => {
    const now = () => Math.floor(Date.now() / 1000);

    it("after device.removed, tokens for that device issued before it are refused everywhere", async () => {
      const token = await issuer.sign(claims(ALEX, { role: "kid" }));
      expect(await status(token)).toBe(200);
      // The second of the removal, read before it: the edge checks below don't depend on how long the requests take.
      const removedAt = now();
      await apply(noRooms, { type: "device.removed", accountId: ALEX, deviceId: 1 });
      for (const [method, path] of [
        ["GET", "/v1/conversations"],
        ["GET", "/v1/conversations/c1/messages"],
        ["POST", "/v1/conversations/c1/acks"],
        ["DELETE", "/v1/conversations/c1"],
        ["GET", "/v1/attachments/a1"],
        ["POST", "/v1/attachments"],
        ["GET", "/v1/conversations/c1/stream"],
      ] as const) {
        const res = await as(token, path, { method, ...(method === "POST" ? { body: "{}" } : {}) });
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(res.headers.get("www-authenticate")).toBe("Bearer");
        expect((await res.json<{ error: { message: string } }>()).error.message).toMatch(/removed/);
      }
      // A token issued just before or in the second after the removal is still refused (no race at the edge).
      expect(await status(await issuer.sign(claims(ALEX, { role: "kid" }), { iat: removedAt - 60 }))).toBe(401);
      expect(await status(await issuer.sign(claims(ALEX, { role: "kid" }), { iat: removedAt + 1 }))).toBe(401);
    });

    it("other devices and accounts are not affected; a token issued after the device registers again works", async () => {
      await apply(noRooms, { type: "device.removed", accountId: ALEX, deviceId: 1 });
      expect(await status(await issuer.sign(claims(ALEX, { role: "kid", dev: 2 })))).toBe(200);
      expect(await status(await issuer.sign(claims(MUM)))).toBe(200);
      // The device registered again (a new pairing): the account service only issues a token for it from then on.
      expect(await status(await issuer.sign(claims(ALEX, { role: "kid" }), { iat: now() + 3 }))).toBe(200);
    });
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
