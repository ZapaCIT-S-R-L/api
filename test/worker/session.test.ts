// GET /v1/me and POST /v1/auth/logout: the session token from sign-in, as a bearer token.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SESSIONS_PER_PARENT } from "../../src/parents";
import {
  ADULT,
  appleClaims,
  bearer,
  call,
  count,
  makeIssuer,
  postJson,
  resetJwksCache,
  sha256Hex,
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

async function signIn(sub = "parent-1"): Promise<SignInBody> {
  const res = await postJson("/v1/auth/apple", {
    identityToken: await apple.sign(appleClaims({ sub })),
    ageRange: ADULT,
    displayName: "Ana",
  });
  return await res.json<SignInBody>();
}

async function expectUnauthorized(res: Response) {
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBe("Bearer");
  expect((await res.json<ErrorBody>()).error.code).toBe("unauthorized");
}

describe("GET /v1/me", () => {
  it("returns the signed-in parent", async () => {
    const { session, parent } = await signIn();
    const res = await call("/v1/me", { headers: bearer(session.token) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(parent);
  });

  it("without a session → 401", async () => {
    await expectUnauthorized(await call("/v1/me"));
  });

  it("with an unknown token → 401", async () => {
    await expectUnauthorized(await call("/v1/me", { headers: bearer(`zks_${"A".repeat(43)}`) }));
  });

  it("with a malformed header → 401", async () => {
    const { session } = await signIn();
    for (const authorization of [session.token, `Basic ${session.token}`, "Bearer", `Bearer ${session.token} x`]) {
      await expectUnauthorized(await call("/v1/me", { headers: { authorization } }));
    }
  });

  it("with the stored hash instead of the token → 401", async () => {
    const { session } = await signIn();
    await expectUnauthorized(await call("/v1/me", { headers: bearer(await sha256Hex(session.token)) }));
  });

  it("with an expired session → 401, and the session is deleted", async () => {
    const { session } = await signIn();
    await env.DB.prepare("UPDATE sessions SET expires_at = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    await expectUnauthorized(await call("/v1/me", { headers: bearer(session.token) }));
    expect(await count("sessions")).toBe(0);
  });

  it("each parent sees only their own profile", async () => {
    const a = await signIn("parent-a");
    const b = await signIn("parent-b");
    const res = await call("/v1/me", { headers: bearer(b.session.token) });
    expect((await res.json<SignInBody["parent"]>()).id).toBe(b.parent.id);
    expect(b.parent.id).not.toBe(a.parent.id);
  });

  it("POST → 405", async () => {
    const { session } = await signIn();
    const res = await call("/v1/me", { method: "POST", headers: bearer(session.token) });
    expect(res.status).toBe(405);
  });
});

describe("POST /v1/auth/logout", () => {
  it("ends this session only", async () => {
    const first = await signIn();
    const second = await signIn();
    const res = await call("/v1/auth/logout", { method: "POST", headers: bearer(first.session.token) });
    expect(res.status).toBe(204);
    await expectUnauthorized(await call("/v1/me", { headers: bearer(first.session.token) }));
    expect((await call("/v1/me", { headers: bearer(second.session.token) })).status).toBe(200);
  });

  it("twice → the second is 401", async () => {
    const { session } = await signIn();
    await call("/v1/auth/logout", { method: "POST", headers: bearer(session.token) });
    await expectUnauthorized(await call("/v1/auth/logout", { method: "POST", headers: bearer(session.token) }));
  });

  it("without a session → 401", async () => {
    await expectUnauthorized(await call("/v1/auth/logout", { method: "POST" }));
  });
});

// Stefan (2026-10-28): "father can't change name". A parent sets their own display name; family lists read it live.
describe("PATCH /v1/me", () => {
  function patch(token: string | null, body: unknown, type = "application/json"): Promise<Response> {
    return call("/v1/me", {
      method: "PATCH",
      headers: { ...(token ? bearer(token) : {}), "content-type": type },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("changes the display name (trimmed) and returns the parent", async () => {
    const { session, parent } = await signIn();
    const res = await patch(session.token, { displayName: "  Tata Stefan  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...parent, displayName: "Tata Stefan" });
    const me = await (await call("/v1/me", { headers: bearer(session.token) })).json<{ displayName: string }>();
    expect(me.displayName).toBe("Tata Stefan");
  });

  it("the family's parent list shows the new name", async () => {
    const { session } = await signIn();
    await patch(session.token, { displayName: "Tata" });
    const res = await call("/v1/families", {
      method: "POST",
      headers: { ...bearer(session.token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Familia" }),
    });
    const family = await res.json<{ parents: { displayName: string | null }[] }>();
    expect(family.parents.map((p) => p.displayName)).toEqual(["Tata"]);
  });

  it.each([
    ["empty after trimming", { displayName: "   " }],
    ["longer than 40 characters", { displayName: "x".repeat(41) }],
    ["control characters", { displayName: "Ta\u0000ta" }],
    ["a newline", { displayName: "Ta\nta" }],
    ["not a string", { displayName: 7 }],
    ["missing", {}],
    ["an unknown field", { displayName: "Tata", email: "x@y.ro" }],
  ])("refuses a name that is %s → 400", async (_what, body) => {
    const { session } = await signIn();
    const res = await patch(session.token, body);
    expect(res.status).toBe(400);
    expect((await res.json<ErrorBody>()).error.code).toBe("invalid_request");
  });

  it("40 characters is fine", async () => {
    const { session } = await signIn();
    expect((await patch(session.token, { displayName: "x".repeat(40) })).status).toBe(200);
  });

  it("without a session, or with a kid session → 401", async () => {
    await expectUnauthorized(await patch(null, { displayName: "Tata" }));
    await expectUnauthorized(await patch(`zkk_${"A".repeat(43)}`, { displayName: "Tata" }));
  });

  it("GET still works and other methods → 405", async () => {
    const { session } = await signIn();
    expect((await call("/v1/me", { headers: bearer(session.token) })).status).toBe(200);
    expect((await call("/v1/me", { method: "DELETE", headers: bearer(session.token) })).status).toBe(405);
  });
});

// Regression (security review 2026-10-27, L8): sessions are capped per parent, and a parent can sign out everywhere.
describe("session limits", () => {
  it("keeps the newest MAX_SESSIONS_PER_PARENT sessions; the oldest is signed out", async () => {
    const tokens: string[] = [];
    for (let i = 0; i < MAX_SESSIONS_PER_PARENT + 1; i++) tokens.push((await signIn()).session.token);
    expect(await count("sessions")).toBe(MAX_SESSIONS_PER_PARENT);
    await expectUnauthorized(await call("/v1/me", { headers: bearer(tokens[0] ?? "") }));
    expect((await call("/v1/me", { headers: bearer(tokens.at(-1) ?? "") })).status).toBe(200);
    expect((await call("/v1/me", { headers: bearer(tokens[1] ?? "") })).status).toBe(200);
  });

  it("the cap is per parent", async () => {
    await signIn("parent-x");
    for (let i = 0; i < MAX_SESSIONS_PER_PARENT; i++) await signIn("parent-y");
    expect(await count("sessions")).toBe(MAX_SESSIONS_PER_PARENT + 1);
  });

  it("POST /v1/auth/logout-all signs out every session of the parent, not other parents", async () => {
    const a1 = await signIn("parent-a");
    const a2 = await signIn("parent-a");
    const b = await signIn("parent-b");
    expect((await call("/v1/auth/logout-all", { method: "POST", headers: bearer(a1.session.token) })).status).toBe(204);
    await expectUnauthorized(await call("/v1/me", { headers: bearer(a1.session.token) }));
    await expectUnauthorized(await call("/v1/me", { headers: bearer(a2.session.token) }));
    expect((await call("/v1/me", { headers: bearer(b.session.token) })).status).toBe(200);
  });

  it("logout-all without a session → 401", async () => {
    await expectUnauthorized(await call("/v1/auth/logout-all", { method: "POST" }));
  });
});
