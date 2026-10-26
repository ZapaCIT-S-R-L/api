// POST /v1/auth/apple: a verified Apple identity token and an adult (or unknown) age range give a session.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADULT,
  appleClaims,
  count,
  makeIssuer,
  call,
  postJson,
  resetJwksCache,
  sha256Hex,
  stubJwks,
  type ErrorBody,
  type JwksStub,
  type SignInBody,
  type TestIssuer,
} from "./helpers";

let apple: TestIssuer;
let jwks: JwksStub;

beforeEach(async () => {
  resetJwksCache();
  apple = await makeIssuer();
  jwks = stubJwks([apple], []);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const signIn = (body: unknown) => postJson("/v1/auth/apple", body);

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect((await res.json<ErrorBody>()).error.code).toBe(code);
}

describe("valid token", () => {
  it("creates the parent and a session", async () => {
    const res = await signIn({ identityToken: await apple.sign(appleClaims()), ageRange: ADULT, displayName: "Ana" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json<SignInBody>();
    expect(body.newAccount).toBe(true);
    expect(body.session.token).toMatch(/^zks_[A-Za-z0-9_-]{43}$/);
    expect(body.parent).toMatchObject({
      email: "parent@privaterelay.appleid.com",
      displayName: "Ana",
      ageRange: { category: "adult", source: "apple_declared_age_range", lowerBound: 18, upperBound: null },
    });
    expect(body.parent.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("the session lasts SESSION_TTL_SECONDS", async () => {
    const before = Date.now();
    const res = await signIn({ identityToken: await apple.sign(appleClaims()), ageRange: ADULT });
    const { session } = await res.json<SignInBody>();
    const ttl = Number(env.SESSION_TTL_SECONDS) * 1000;
    const expires = Date.parse(session.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(before + ttl - 1000);
    expect(expires).toBeLessThanOrEqual(Date.now() + ttl + 1000);
  });

  it("stores only the SHA-256 of the session token, never the token", async () => {
    const res = await signIn({ identityToken: await apple.sign(appleClaims()), ageRange: ADULT });
    const { session } = await res.json<SignInBody>();
    const rows = await env.DB.prepare("SELECT * FROM sessions").all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.token_hash).toBe(await sha256Hex(session.token));
    expect(JSON.stringify(rows.results)).not.toContain(session.token);
    expect(JSON.stringify(rows.results)).not.toContain(session.token.slice(4));
  });

  it("signing in again finds the same parent and starts a new session", async () => {
    const firstRes = await signIn({
      identityToken: await apple.sign(appleClaims()),
      ageRange: ADULT,
      displayName: "Ana",
    });
    const first = await firstRes.json<SignInBody>();
    const secondRes = await signIn({
      identityToken: await apple.sign(appleClaims({ email: undefined })),
      ageRange: ADULT,
    });
    const second = await secondRes.json<SignInBody>();
    expect(second.newAccount).toBe(false);
    expect(second.parent.id).toBe(first.parent.id);
    expect(second.parent.email).toBe("parent@privaterelay.appleid.com");
    expect(second.parent.displayName).toBe("Ana");
    expect(second.session.token).not.toBe(first.session.token);
    expect(await count("parents")).toBe(1);
    expect(await count("sessions")).toBe(2);
  });

  it("age API not available (unavailable) → allowed, recorded as unavailable", async () => {
    const ageRange = {
      availability: "unavailable",
      source: "apple_declared_age_range",
      lowerBound: null,
      upperBound: null,
      platformStatus: "notAvailable",
    };
    const res = await signIn({ identityToken: await apple.sign(appleClaims()), ageRange });
    expect(res.status).toBe(200);
    const { parent } = await res.json<SignInBody>();
    expect(parent.ageRange).toMatchObject({
      category: "unavailable",
      lowerBound: null,
      platformStatus: "notAvailable",
    });
  });

  it("an adult range with an upper bound (25-34) is adult", async () => {
    const ageRange = { availability: "shared", source: "apple_declared_age_range", lowerBound: 25, upperBound: 34 };
    const res = await signIn({ identityToken: await apple.sign(appleClaims()), ageRange });
    expect((await res.json<SignInBody>()).parent.ageRange.category).toBe("adult");
  });

  it("ignores an email Apple marks unverified", async () => {
    const token = await apple.sign(appleClaims({ email_verified: "false" }));
    const { parent } = await (await signIn({ identityToken: token, ageRange: ADULT })).json<SignInBody>();
    expect(parent.email).toBeNull();
  });

  it("accepts a key Apple rotated in (unknown kid → fetch the keys again)", async () => {
    await signIn({ identityToken: await apple.sign(appleClaims()), ageRange: ADULT });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 10 * 60_000 });
    const rotated = await makeIssuer();
    jwks.apple = [apple.jwk, rotated.jwk];
    const res = await signIn({ identityToken: await rotated.sign(appleClaims()), ageRange: ADULT });
    expect(res.status).toBe(200);
    expect(jwks.calls.length).toBe(2);
  });

  it("caches Apple's keys between sign-ins", async () => {
    await signIn({ identityToken: await apple.sign(appleClaims()), ageRange: ADULT });
    await signIn({ identityToken: await apple.sign(appleClaims()), ageRange: ADULT });
    expect(jwks.calls).toEqual(["https://appleid.apple.com/auth/keys"]);
  });
});

describe("invalid token → 401 invalid_token", () => {
  it("wrong audience (another app)", async () => {
    const token = await apple.sign(appleClaims({ aud: "com.example.other" }));
    await expectError(await signIn({ identityToken: token, ageRange: ADULT }), 401, "invalid_token");
  });

  it("wrong issuer", async () => {
    const token = await apple.sign(appleClaims({ iss: "https://accounts.google.com" }));
    await expectError(await signIn({ identityToken: token, ageRange: ADULT }), 401, "invalid_token");
  });

  it("expired", async () => {
    const token = await apple.sign(appleClaims(), { expiresIn: Math.floor(Date.now() / 1000) - 120 });
    await expectError(await signIn({ identityToken: token, ageRange: ADULT }), 401, "invalid_token");
  });

  it("bad signature (another key with the same kid)", async () => {
    const forger = await makeIssuer(apple.kid);
    const token = await forger.sign(appleClaims());
    await expectError(await signIn({ identityToken: token, ageRange: ADULT }), 401, "invalid_token");
  });

  it("tampered payload", async () => {
    const [h, , s] = (await apple.sign(appleClaims())).split(".");
    const payload = btoa(JSON.stringify(appleClaims({ sub: "someone-else" }))).replace(/=+$/, "");
    await expectError(await signIn({ identityToken: `${h}.${payload}.${s}`, ageRange: ADULT }), 401, "invalid_token");
  });

  it("unknown key id, and a second unknown kid right after doesn't fetch again", async () => {
    const stranger = await makeIssuer();
    await expectError(
      await signIn({ identityToken: await stranger.sign(appleClaims()), ageRange: ADULT }),
      401,
      "invalid_token",
    );
    await expectError(
      await signIn({ identityToken: await stranger.sign(appleClaims()), ageRange: ADULT }),
      401,
      "invalid_token",
    );
    expect(jwks.calls.length).toBe(1);
  });

  it('alg "none"', async () => {
    const enc = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "");
    const token = `${enc({ alg: "none", kid: apple.kid })}.${enc({ ...appleClaims(), exp: Date.now() / 1000 + 600 })}.`;
    await expectError(await signIn({ identityToken: token, ageRange: ADULT }), 401, "invalid_token");
  });

  it("no subject", async () => {
    const token = await apple.sign(appleClaims({ sub: undefined }));
    await expectError(await signIn({ identityToken: token, ageRange: ADULT }), 401, "invalid_token");
  });

  it("not a JWT", async () => {
    await expectError(await signIn({ identityToken: "not-a-jwt", ageRange: ADULT }), 401, "invalid_token");
  });

  it("a Google token sent to the Apple endpoint", async () => {
    const google = await makeIssuer();
    const token = await google.sign({ iss: "https://accounts.google.com", aud: "x", sub: "1" });
    await expectError(await signIn({ identityToken: token, ageRange: ADULT }), 401, "invalid_token");
  });

  it("creates nothing", async () => {
    await signIn({ identityToken: await apple.sign(appleClaims({ aud: "x" })), ageRange: ADULT });
    expect(await count("parents")).toBe(0);
    expect(await count("sessions")).toBe(0);
  });
});

describe("minor → 403 minor_not_allowed", () => {
  it("rejects an upper bound under 18 and stores nothing", async () => {
    const ageRange = { availability: "shared", source: "apple_declared_age_range", lowerBound: 13, upperBound: 15 };
    await expectError(
      await signIn({ identityToken: await apple.sign(appleClaims()), ageRange }),
      403,
      "minor_not_allowed",
    );
    expect(await count("parents")).toBe(0);
    expect(await count("parent_identities")).toBe(0);
    expect(await count("sessions")).toBe(0);
  });

  it("rejects 17 as the upper bound", async () => {
    const ageRange = { availability: "shared", source: "apple_declared_age_range", lowerBound: null, upperBound: 17 };
    await expectError(
      await signIn({ identityToken: await apple.sign(appleClaims()), ageRange }),
      403,
      "minor_not_allowed",
    );
  });

  it("an existing parent who now reports a minor range gets no session", async () => {
    await signIn({ identityToken: await apple.sign(appleClaims()), ageRange: ADULT });
    const ageRange = { availability: "shared", source: "apple_declared_age_range", lowerBound: null, upperBound: 12 };
    await expectError(
      await signIn({ identityToken: await apple.sign(appleClaims()), ageRange }),
      403,
      "minor_not_allowed",
    );
    expect(await count("sessions")).toBe(1);
  });

  it("checks the token before the age range (a bad token is 401, not 403)", async () => {
    const ageRange = { availability: "shared", source: "apple_declared_age_range", lowerBound: null, upperBound: 12 };
    await expectError(await signIn({ identityToken: "x.y.z", ageRange }), 401, "invalid_token");
  });
});

describe("age range not shared or not adult → 403", () => {
  it("declined to share → 403 age_declined, nothing stored", async () => {
    const ageRange = {
      availability: "declined",
      source: "apple_declared_age_range",
      lowerBound: null,
      upperBound: null,
    };
    await expectError(await signIn({ identityToken: await apple.sign(appleClaims()), ageRange }), 403, "age_declined");
    expect(await count("parents")).toBe(0);
    expect(await count("sessions")).toBe(0);
  });

  it("a shared range that doesn't prove 18+ (16 and up) → 403 minor_not_allowed", async () => {
    const ageRange = { availability: "shared", source: "apple_declared_age_range", lowerBound: 16, upperBound: null };
    await expectError(
      await signIn({ identityToken: await apple.sign(appleClaims()), ageRange }),
      403,
      "minor_not_allowed",
    );
  });

  it("an existing parent who now declines gets no session", async () => {
    await signIn({ identityToken: await apple.sign(appleClaims()), ageRange: ADULT });
    const ageRange = {
      availability: "declined",
      source: "apple_declared_age_range",
      lowerBound: null,
      upperBound: null,
    };
    await expectError(await signIn({ identityToken: await apple.sign(appleClaims()), ageRange }), 403, "age_declined");
    expect(await count("sessions")).toBe(1);
  });
});

describe("bad requests", () => {
  const cases: [string, unknown][] = [
    ["no token", { ageRange: ADULT }],
    ["no age range", { identityToken: "a.b.c" }],
    ["token not a string", { identityToken: 5, ageRange: ADULT }],
    [
      "no availability",
      { identityToken: "a.b.c", ageRange: { source: ADULT.source, lowerBound: 18, upperBound: null } },
    ],
    ["unknown availability", { identityToken: "a.b.c", ageRange: { ...ADULT, availability: "maybe" } }],
    ["shared without bounds", { identityToken: "a.b.c", ageRange: { ...ADULT, lowerBound: null } }],
    ["declined with bounds", { identityToken: "a.b.c", ageRange: { ...ADULT, availability: "declined" } }],
    ["unavailable with bounds", { identityToken: "a.b.c", ageRange: { ...ADULT, availability: "unavailable" } }],
    ["no nonce", { identityToken: "a.b.c", ageRange: ADULT, nonce: undefined }],
    ["nonce not a string", { identityToken: "a.b.c", ageRange: ADULT, nonce: 7 }],
    ["unknown source", { identityToken: "a.b.c", ageRange: { ...ADULT, source: "selfie" } }],
    ["bound not an integer", { identityToken: "a.b.c", ageRange: { ...ADULT, lowerBound: 18.5 } }],
    [
      "bound missing",
      { identityToken: "a.b.c", ageRange: { availability: "shared", source: ADULT.source, lowerBound: 18 } },
    ],
    ["negative bound", { identityToken: "a.b.c", ageRange: { ...ADULT, lowerBound: -1 } }],
    ["lower above upper", { identityToken: "a.b.c", ageRange: { ...ADULT, lowerBound: 30, upperBound: 20 } }],
    ["bad platformStatus", { identityToken: "a.b.c", ageRange: { ...ADULT, platformStatus: "<script>" } }],
    ["unknown field", { identityToken: "a.b.c", ageRange: ADULT, isAdmin: true }],
    ["display name too long", { identityToken: "a.b.c", ageRange: ADULT, displayName: "x".repeat(101) }],
    ["token too long", { identityToken: "x".repeat(8193), ageRange: ADULT }],
    ["not an object", [1, 2]],
    ["not JSON", "{nope"],
  ];
  for (const [why, body] of cases) {
    it(`${why} → 400 invalid_request`, async () => {
      await expectError(await signIn(body), 400, "invalid_request");
    });
  }

  it("not JSON content type → 415", async () => {
    const res = await postJson("/v1/auth/apple", "{}", { "content-type": "text/plain" });
    await expectError(res, 415, "unsupported_media_type");
  });

  it("body over 16 KiB → 413", async () => {
    const res = await signIn({ identityToken: "a.b.c", ageRange: ADULT, pad: "x".repeat(17_000) });
    await expectError(res, 413, "payload_too_large");
  });

  it("a streamed body over 16 KiB without Content-Length → 413", async () => {
    const chunk = new TextEncoder().encode("x".repeat(4096));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 10) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const res = await call("/v1/auth/apple", { method: "POST", headers: { "content-type": "application/json" }, body });
    await expectError(res, 413, "payload_too_large");
    expect(sent).toBeLessThan(10);
  });

  it("GET → 405", async () => {
    const res = await call("/v1/auth/apple");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("Apple's keys unavailable → 503 provider_unavailable", () => {
  it("answers 503 and creates nothing", async () => {
    jwks.fail = true;
    await expectError(
      await signIn({ identityToken: await apple.sign(appleClaims()), ageRange: ADULT }),
      503,
      "provider_unavailable",
    );
    expect(await count("parents")).toBe(0);
  });
});
