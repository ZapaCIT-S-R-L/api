// Sign in with Apple on Android (Apple's web flow): start with a PKCE challenge, Apple form_posts to the callback,
// the API redirects to the app link with a one-time code, the app exchanges code + verifier + nonce for a session.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADULT,
  APPLE_SERVICES_ID,
  appleClaims,
  call,
  count,
  makeIssuer,
  pendingNonce,
  postJson,
  resetJwksCache,
  stubJwks,
  type ErrorBody,
  type SignInBody,
  type TestIssuer,
} from "./helpers";

let apple: TestIssuer;

beforeEach(async () => {
  resetJwksCache();
  apple = await makeIssuer();
  stubJwks([apple], []);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

async function start() {
  const { verifier, challenge } = await pkce();
  const res = await postJson("/v1/auth/apple/web", { codeChallenge: challenge, codeChallengeMethod: "S256" });
  expect(res.status).toBe(200);
  const { state } = await res.json<{ state: string }>();
  return { state, verifier };
}

function callback(fields: Record<string, string>, contentType = "application/x-www-form-urlencoded") {
  return call("/v1/auth/apple/callback", {
    method: "POST",
    headers: { "content-type": contentType },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

// The fragment parameters of the app link the callback redirects to.
function handBack(res: Response): URLSearchParams {
  expect(res.status).toBe(303);
  const location = res.headers.get("location") ?? "";
  expect(location.startsWith("https://zapakid.ro/app/apple#")).toBe(true);
  return new URLSearchParams(location.split("#")[1]);
}

const webToken = (claims: Record<string, unknown> = {}) =>
  apple.sign(appleClaims({ aud: APPLE_SERVICES_ID, ...claims }));
const exchange = (body: Record<string, unknown>) => postJson("/v1/auth/apple/exchange", body);

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect((await res.json<ErrorBody>()).error.code).toBe(code);
}

// Runs start + callback; returns what the app holds afterwards.
async function throughCallback(claims: Record<string, unknown> = {}, extra: Record<string, string> = {}) {
  const nonce = pendingNonce();
  if (!nonce) throw new Error("no pending nonce");
  const { state, verifier } = await start();
  const fragment = handBack(
    await callback({ state, id_token: await webToken({ nonce: nonce.hash, ...claims }), code: "apple-code", ...extra }),
  );
  return { state, verifier, nonce: nonce.nonce, fragment };
}

describe("the full web flow", () => {
  it("start → callback → exchange gives a session, with the name Apple sent once", async () => {
    const user = JSON.stringify({ name: { firstName: "Ana", lastName: "Pop" }, email: "x@privaterelay.appleid.com" });
    const { state, verifier, nonce, fragment } = await throughCallback({}, { user });
    expect(fragment.get("state")).toBe(state);
    const code = fragment.get("code") ?? "";
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const res = await exchange({ code, codeVerifier: verifier, nonce, ageRange: ADULT });
    expect(res.status).toBe(200);
    const body = await res.json<SignInBody>();
    expect(body.newAccount).toBe(true);
    expect(body.parent.displayName).toBe("Ana Pop");
    expect(body.session.token).toMatch(/^zks_/);
  });

  it("the redirect carries no Apple token or code, and isn't cached or leaked by Referer", async () => {
    const nonce = pendingNonce();
    const { state } = await start();
    const idToken = await webToken({ nonce: nonce?.hash });
    const res = await callback({ state, id_token: idToken, code: "apple-auth-code-123" });
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain(idToken.split(".")[1]);
    expect(location).not.toContain("apple-auth-code-123");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("keeps no Apple token at rest", async () => {
    const nonce = pendingNonce();
    const { state } = await start();
    const idToken = await webToken({ nonce: nonce?.hash });
    await callback({ state, id_token: idToken });
    const rows = await env.DB.prepare("SELECT * FROM apple_web_flows").all();
    expect(JSON.stringify(rows.results)).not.toContain(idToken.split(".")[2]);
  });

  it("the native endpoint accepts a Services ID token too (config-driven audiences)", async () => {
    const res = await postJson("/v1/auth/apple", { identityToken: await webToken(), ageRange: ADULT });
    expect(res.status).toBe(200);
  });
});

describe("start", () => {
  const bad: [string, unknown][] = [
    ["no challenge", { codeChallengeMethod: "S256" }],
    ["plain method", { codeChallenge: "A".repeat(43), codeChallengeMethod: "plain" }],
    ["short challenge", { codeChallenge: "abc", codeChallengeMethod: "S256" }],
    ["extra field", { codeChallenge: "A".repeat(43), codeChallengeMethod: "S256", redirect: "https://evil" }],
  ];
  for (const [why, body] of bad) {
    it(`${why} → 400`, async () => {
      await expectError(await postJson("/v1/auth/apple/web", body), 400, "invalid_request");
    });
  }
});

describe("callback", () => {
  it("unknown state → #error=invalid_state", async () => {
    const fragment = handBack(await callback({ state: "B".repeat(43), id_token: await webToken() }));
    expect(fragment.get("error")).toBe("invalid_state");
    expect(fragment.get("code")).toBeNull();
  });

  it("a state works once", async () => {
    const { state } = await start();
    const token = await webToken({ nonce: pendingNonce()?.hash });
    expect(handBack(await callback({ state, id_token: token })).get("code")).not.toBeNull();
    expect(handBack(await callback({ state, id_token: token })).get("error")).toBe("invalid_state");
  });

  it("an expired flow → invalid_state", async () => {
    const { state } = await start();
    await env.DB.prepare("UPDATE apple_web_flows SET expires_at = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    expect(handBack(await callback({ state, id_token: await webToken() })).get("error")).toBe("invalid_state");
  });

  it("a token for another app → #error=invalid_token, and the flow is closed", async () => {
    const { state } = await start();
    const fragment = handBack(await callback({ state, id_token: await webToken({ aud: "com.example.other" }) }));
    expect(fragment.get("error")).toBe("invalid_token");
    expect(fragment.get("state")).toBe(state);
    expect(handBack(await callback({ state, id_token: await webToken() })).get("error")).toBe("invalid_state");
  });

  it("Apple's error (user cancelled) is passed on; odd values are not", async () => {
    const { state } = await start();
    expect(handBack(await callback({ state, error: "user_cancelled_authorize" })).get("error")).toBe(
      "user_cancelled_authorize",
    );
    const second = await start();
    expect(handBack(await callback({ state: second.state, error: "<script>" })).get("error")).toBe("apple_error");
  });

  it("no id_token → invalid_token", async () => {
    const { state } = await start();
    expect(handBack(await callback({ state })).get("error")).toBe("invalid_token");
  });

  it("not a form post → #error=invalid_request", async () => {
    const res = await call("/v1/auth/apple/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      redirect: "manual",
    });
    expect(handBack(res).get("error")).toBe("invalid_request");
  });

  it("a state from the fragment is never reflected unchecked", async () => {
    const fragment = handBack(await callback({ state: "x&code=evil", id_token: "a" }));
    expect(fragment.get("code")).toBeNull();
    expect(fragment.get("state")).toBeNull();
  });
});

describe("exchange", () => {
  it("wrong PKCE verifier → 401 invalid_code, and the code is burned", async () => {
    const { verifier, nonce, fragment } = await throughCallback();
    const code = fragment.get("code") ?? "";
    await expectError(
      await exchange({ code, codeVerifier: "x".repeat(43), nonce, ageRange: ADULT }),
      401,
      "invalid_code",
    );
    await expectError(await exchange({ code, codeVerifier: verifier, nonce, ageRange: ADULT }), 401, "invalid_code");
    expect(await count("sessions")).toBe(0);
  });

  it("a code works once", async () => {
    const { verifier, nonce, fragment } = await throughCallback();
    const code = fragment.get("code") ?? "";
    expect((await exchange({ code, codeVerifier: verifier, nonce, ageRange: ADULT })).status).toBe(200);
    await expectError(await exchange({ code, codeVerifier: verifier, nonce, ageRange: ADULT }), 401, "invalid_code");
  });

  it("an expired code → 401 invalid_code", async () => {
    const { verifier, nonce, fragment } = await throughCallback();
    await env.DB.prepare("UPDATE apple_web_flows SET code_expires_at = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    await expectError(
      await exchange({ code: fragment.get("code") ?? "", codeVerifier: verifier, nonce, ageRange: ADULT }),
      401,
      "invalid_code",
    );
  });

  it("an unknown code → 401 invalid_code", async () => {
    await expectError(
      await exchange({ code: "C".repeat(43), codeVerifier: "v".repeat(43), nonce: "N".repeat(43), ageRange: ADULT }),
      401,
      "invalid_code",
    );
  });

  it("the nonce rules apply: another nonce → 401 invalid_nonce", async () => {
    const { verifier, fragment } = await throughCallback();
    await expectError(
      await exchange({
        code: fragment.get("code") ?? "",
        codeVerifier: verifier,
        nonce: "N".repeat(43),
        ageRange: ADULT,
      }),
      401,
      "invalid_nonce",
    );
  });

  it("the age rules apply: declined → 403 age_declined", async () => {
    const { verifier, nonce, fragment } = await throughCallback();
    const ageRange = {
      availability: "declined",
      source: "google_play_age_signals",
      lowerBound: null,
      upperBound: null,
    };
    await expectError(
      await exchange({ code: fragment.get("code") ?? "", codeVerifier: verifier, nonce, ageRange }),
      403,
      "age_declined",
    );
  });

  it("bad body → 400", async () => {
    await expectError(await exchange({ code: "C".repeat(43) }), 400, "invalid_request");
  });
});
