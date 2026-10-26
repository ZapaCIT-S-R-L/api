// POST /v1/auth/google: a verified Google ID token for one of ZapaKid's OAuth clients gives a session.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADULT,
  ADULT_GOOGLE,
  appleClaims,
  count,
  googleClaims,
  makeIssuer,
  postJson,
  resetJwksCache,
  stubJwks,
  type ErrorBody,
  type JwksStub,
  type SignInBody,
  type TestIssuer,
} from "./helpers";

let google: TestIssuer;
let apple: TestIssuer;
let jwks: JwksStub;

beforeEach(async () => {
  resetJwksCache();
  google = await makeIssuer();
  apple = await makeIssuer();
  jwks = stubJwks([apple], [google]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const signIn = (body: unknown) => postJson("/v1/auth/google", body);

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect((await res.json<ErrorBody>()).error.code).toBe(code);
}

describe("valid token", () => {
  it("creates the parent with the verified email and Google's name", async () => {
    const res = await signIn({ idToken: await google.sign(googleClaims()), ageRange: ADULT_GOOGLE });
    expect(res.status).toBe(200);
    const body = await res.json<SignInBody>();
    expect(body.newAccount).toBe(true);
    expect(body.parent).toMatchObject({
      email: "parent@example.com",
      displayName: "Test Parent",
      ageRange: { category: "adult", source: "google_play_age_signals", platformStatus: "VERIFIED" },
    });
    expect(jwks.calls).toEqual(["https://www.googleapis.com/oauth2/v3/certs"]);
  });

  it('accepts the issuer without https ("accounts.google.com")', async () => {
    const token = await google.sign(googleClaims({ iss: "accounts.google.com" }));
    expect((await signIn({ idToken: token, ageRange: ADULT_GOOGLE })).status).toBe(200);
  });

  it("accepts the Declared Age Range on iOS", async () => {
    expect((await signIn({ idToken: await google.sign(googleClaims()), ageRange: ADULT })).status).toBe(200);
  });

  it("drops an unverified email", async () => {
    const token = await google.sign(googleClaims({ email_verified: false }));
    const { parent } = await (await signIn({ idToken: token, ageRange: ADULT_GOOGLE })).json<SignInBody>();
    expect(parent.email).toBeNull();
  });

  it("never links accounts by email: the same email on Apple and Google is two parents", async () => {
    const aRes = await postJson("/v1/auth/apple", {
      identityToken: await apple.sign(appleClaims({ email: "same@example.com" })),
      ageRange: ADULT,
    });
    const a = await aRes.json<SignInBody>();
    const gToken = await google.sign(googleClaims({ email: "same@example.com" }));
    const g = await (await signIn({ idToken: gToken, ageRange: ADULT_GOOGLE })).json<SignInBody>();
    expect(g.parent.id).not.toBe(a.parent.id);
    expect(await count("parents")).toBe(2);
  });

  it("the same subject on Apple and Google is two identities", async () => {
    const sub = "shared-subject";
    await postJson("/v1/auth/apple", { identityToken: await apple.sign(appleClaims({ sub })), ageRange: ADULT });
    await signIn({ idToken: await google.sign(googleClaims({ sub })), ageRange: ADULT_GOOGLE });
    expect(await count("parent_identities")).toBe(2);
  });
});

describe("invalid token → 401 invalid_token", () => {
  it("wrong audience (another OAuth client)", async () => {
    const token = await google.sign(googleClaims({ aud: "123-other.apps.googleusercontent.com" }));
    await expectError(await signIn({ idToken: token, ageRange: ADULT_GOOGLE }), 401, "invalid_token");
  });

  it("wrong issuer", async () => {
    const token = await google.sign(googleClaims({ iss: "https://evil.example" }));
    await expectError(await signIn({ idToken: token, ageRange: ADULT_GOOGLE }), 401, "invalid_token");
  });

  it("expired", async () => {
    const token = await google.sign(googleClaims(), { expiresIn: Math.floor(Date.now() / 1000) - 120 });
    await expectError(await signIn({ idToken: token, ageRange: ADULT_GOOGLE }), 401, "invalid_token");
  });

  it("bad signature", async () => {
    const forger = await makeIssuer(google.kid);
    await expectError(
      await signIn({ idToken: await forger.sign(googleClaims()), ageRange: ADULT_GOOGLE }),
      401,
      "invalid_token",
    );
  });

  it("an Apple token (signed by Apple's key) sent to the Google endpoint", async () => {
    const token = await apple.sign(appleClaims());
    await expectError(await signIn({ idToken: token, ageRange: ADULT_GOOGLE }), 401, "invalid_token");
  });

  it("HS256 with the public key as secret (algorithm confusion)", async () => {
    const enc = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "");
    const token = `${enc({ alg: "HS256", kid: google.kid })}.${enc(googleClaims({ exp: Date.now() / 1000 + 600 }))}.c2ln`;
    await expectError(await signIn({ idToken: token, ageRange: ADULT_GOOGLE }), 401, "invalid_token");
  });
});

describe("minor", () => {
  it("a supervised account (13-15) → 403, nothing stored", async () => {
    const ageRange = {
      source: "google_play_age_signals",
      lowerBound: 13,
      upperBound: 15,
      platformStatus: "SUPERVISED",
    };
    await expectError(await signIn({ idToken: await google.sign(googleClaims()), ageRange }), 403, "minor_not_allowed");
    expect(await count("parents")).toBe(0);
  });
});

describe("bad requests", () => {
  it("the Apple field name → 400", async () => {
    await expectError(await signIn({ identityToken: "a.b.c", ageRange: ADULT_GOOGLE }), 400, "invalid_request");
  });

  it("displayName is not accepted (Google's name comes from the token)", async () => {
    const body = { idToken: "a.b.c", ageRange: ADULT_GOOGLE, displayName: "x" };
    await expectError(await signIn(body), 400, "invalid_request");
  });
});
