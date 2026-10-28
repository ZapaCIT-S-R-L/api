// Kid pairing by QR: a parent creates a one-time code for a kid (new or existing), the kid's phone redeems it and
// gets a kid session. Kids never sign in with Apple or Google.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import {
  call,
  count,
  makeIssuer,
  resetJwksCache,
  sha256Hex,
  signInParent,
  stubJwks,
  workerRequest,
  type ErrorBody,
  type TestIssuer,
} from "./helpers";

interface Kid {
  id: string;
  nickname: string;
  avatar: string;
  grade: number | null;
  createdAt: string;
}
interface Pairing {
  code: string;
  expiresAt: string;
  kid: Kid;
}
interface Redeemed {
  session: { token: string; expiresAt: string };
  kid: Kid;
  family: { id: string; name: string | null };
}

let apple: TestIssuer;

beforeEach(async () => {
  resetJwksCache();
  apple = await makeIssuer();
  stubJwks([apple], []);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function send(path: string, auth: Record<string, string>, body?: unknown, method = "POST"): Promise<Response> {
  return call(path, {
    method,
    headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// A parent with a family and one kid.
async function parentWithKid(sub = "ana") {
  const parent = await signInParent(apple, sub);
  const family = await (await send("/v1/families", parent.auth, { name: "Pop" })).json<{ id: string }>();
  const kid = await (
    await send(`/v1/families/${family.id}/kids`, parent.auth, { nickname: "Mia", avatar: "robot-1", grade: 1 })
  ).json<Kid>();
  return { parent, family, kid };
}

async function pair(auth: Record<string, string>, familyId: string, kidId: string): Promise<Pairing> {
  const res = await send(`/v1/families/${familyId}/kids/${kidId}/pairing`, auth);
  expect(res.status).toBe(201);
  return res.json<Pairing>();
}

const redeem = (code: unknown, headers: Record<string, string> = {}) =>
  call("/v1/pairing/redeem", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ code }),
  });

async function errorCode(res: Response): Promise<string> {
  return (await res.json<ErrorBody>()).error.code;
}

describe("POST /v1/families/{familyId}/kids/{kidId}/pairing", () => {
  it("without a session → 401", async () => {
    const { family, kid } = await parentWithKid();
    expect((await send(`/v1/families/${family.id}/kids/${kid.id}/pairing`, {})).status).toBe(401);
  });

  it("creates a one-time code valid for 5 minutes, stored as a hash only", async () => {
    const { parent, family, kid } = await parentWithKid();
    const { code, expiresAt, kid: forKid } = await pair(parent.auth, family.id, kid.id);
    expect(code).toMatch(/^zkp_[A-Za-z0-9_-]{43}$/);
    const minutes = (Date.parse(expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(4.9);
    expect(minutes).toBeLessThanOrEqual(5);
    expect(forKid).toEqual(kid);
    const row = await env.DB.prepare("SELECT code_hash FROM kid_pairings").first<{ code_hash: string }>();
    expect(row?.code_hash).toBe(await sha256Hex(code));
  });

  // Regression (staging, 2026-10-28): the iOS app sends this POST with an empty body (Content-Length: 0) and no
  // Content-Type; that got 415 unsupported_media_type instead of a code.
  it("an empty body without Content-Type creates a code", async () => {
    const { parent, family, kid } = await parentWithKid();
    const res = await call(`/v1/families/${family.id}/kids/${kid.id}/pairing`, {
      method: "POST",
      headers: { ...parent.auth, "content-length": "0" },
      body: "",
    });
    expect(res.status).toBe(201);
  });

  it("a non-empty body is still refused unless it is {}", async () => {
    const { parent, family, kid } = await parentWithKid();
    const path = `/v1/families/${family.id}/kids/${kid.id}/pairing`;
    expect((await send(path, parent.auth, {})).status).toBe(201);
    expect((await send(path, parent.auth, { kidId: "x" })).status).toBe(400);
  });

  it("a non-member, or a kid of another family → 404", async () => {
    const ana = await parentWithKid("ana");
    const bob = await parentWithKid("bob");
    expect((await send(`/v1/families/${ana.family.id}/kids/${ana.kid.id}/pairing`, bob.parent.auth)).status).toBe(404);
    expect((await send(`/v1/families/${ana.family.id}/kids/${bob.kid.id}/pairing`, ana.parent.auth)).status).toBe(404);
    expect(
      (await send(`/v1/families/${ana.family.id}/kids/${crypto.randomUUID()}/pairing`, ana.parent.auth)).status,
    ).toBe(404);
    expect(await count("kid_pairings")).toBe(0);
  });

  it("at most 5 open codes per family → 429", async () => {
    const { parent, family, kid } = await parentWithKid();
    for (let i = 0; i < 5; i++) await pair(parent.auth, family.id, kid.id);
    const res = await send(`/v1/families/${family.id}/kids/${kid.id}/pairing`, parent.auth);
    expect(res.status).toBe(429);
    // A code lives 5 minutes, so one frees up within that.
    expect(res.headers.get("retry-after")).toBe("300");
    expect(await errorCode(res)).toBe("too_many_pairings");
  });

  it("GET → 405", async () => {
    const { parent, family, kid } = await parentWithKid();
    const res = await call(`/v1/families/${family.id}/kids/${kid.id}/pairing`, { headers: parent.auth });
    expect(res.status).toBe(405);
  });
});

describe("POST /v1/pairing/redeem", () => {
  it("gives the kid's phone a kid session, the kid and the family", async () => {
    const { parent, family, kid } = await parentWithKid();
    const { code } = await pair(parent.auth, family.id, kid.id);
    const res = await redeem(code);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json<Redeemed>();
    expect(body.session.token).toMatch(/^zkk_[A-Za-z0-9_-]{43}$/);
    // Review of #61: 30 days until kid unpair/logout exists (365 had no way to revoke a lost kid phone).
    const days = (Date.parse(body.session.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    expect(body.kid).toEqual(kid);
    expect(body.family).toEqual({ id: family.id, name: "Pop" });
    const row = await env.DB.prepare("SELECT token_hash, kid_id FROM kid_sessions").first<{
      token_hash: string;
      kid_id: string;
    }>();
    expect(row).toEqual({ token_hash: await sha256Hex(body.session.token), kid_id: kid.id });
  });

  it("the kid session reads the kid's family", async () => {
    const { parent, family, kid } = await parentWithKid();
    const { session } = await (await redeem((await pair(parent.auth, family.id, kid.id)).code)).json<Redeemed>();
    const res = await call("/v1/families", { headers: { authorization: `Bearer ${session.token}` } });
    expect(res.status).toBe(200);
    const { families } = await res.json<{ families: { id: string; kids: Kid[]; parents: { id: string }[] }[] }>();
    expect(families.map((f) => f.id)).toEqual([family.id]);
    expect(families[0]?.parents.map((p) => p.id)).toEqual([parent.id]);
  });

  it("a kid session can't act as a parent → 401", async () => {
    const { parent, family, kid } = await parentWithKid();
    const { session } = await (await redeem((await pair(parent.auth, family.id, kid.id)).code)).json<Redeemed>();
    const auth = { authorization: `Bearer ${session.token}` };
    expect((await send("/v1/families", auth, {})).status).toBe(401);
    expect((await send(`/v1/families/${family.id}/parents/invitations`, auth)).status).toBe(401);
    expect((await send(`/v1/families/${family.id}/kids`, auth, { nickname: "X", avatar: "robot-1" })).status).toBe(401);
    expect((await send(`/v1/families/${family.id}/kids/${kid.id}/pairing`, auth)).status).toBe(401);
    expect((await call("/v1/me", { headers: auth })).status).toBe(401);
  });

  it("a used code → 410, no second session", async () => {
    const { parent, family, kid } = await parentWithKid();
    const { code } = await pair(parent.auth, family.id, kid.id);
    expect((await redeem(code)).status).toBe(200);
    const again = await redeem(code);
    expect(again.status).toBe(410);
    expect(await errorCode(again)).toBe("pairing_code_invalid");
    expect(await count("kid_sessions")).toBe(1);
  });

  it("an expired or unknown code → 410", async () => {
    const { parent, family, kid } = await parentWithKid();
    const { code } = await pair(parent.auth, family.id, kid.id);
    await env.DB.prepare("UPDATE kid_pairings SET expires_at = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    expect((await redeem(code)).status).toBe(410);
    expect((await redeem(`zkp_${"A".repeat(43)}`)).status).toBe(410);
    expect(await count("kid_sessions")).toBe(0);
  });

  it("a malformed code → 400", async () => {
    for (const code of ["nope", 5, null, `zki_${"A".repeat(43)}`]) expect((await redeem(code)).status).toBe(400);
  });

  it("an existing kid's new phone: a second code gives a second session for the same kid", async () => {
    const { parent, family, kid } = await parentWithKid();
    const first = await (await redeem((await pair(parent.auth, family.id, kid.id)).code)).json<Redeemed>();
    const second = await (await redeem((await pair(parent.auth, family.id, kid.id)).code)).json<Redeemed>();
    expect(second.kid.id).toBe(kid.id);
    expect(second.session.token).not.toBe(first.session.token);
    for (const token of [first.session.token, second.session.token]) {
      expect((await call("/v1/families", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    }
  });

  it("an expired kid session → 401, and it is deleted", async () => {
    const { parent, family, kid } = await parentWithKid();
    const { session } = await (await redeem((await pair(parent.auth, family.id, kid.id)).code)).json<Redeemed>();
    await env.DB.prepare("UPDATE kid_sessions SET expires_at = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    expect((await call("/v1/families", { headers: { authorization: `Bearer ${session.token}` } })).status).toBe(401);
    expect(await count("kid_sessions")).toBe(0);
  });

  it("is rate limited per address (AUTH_LIMITER)", async () => {
    const headers = { "cf-connecting-ip": "198.51.100.77" };
    for (let i = 0; i < 5; i++) expect((await redeem(`zkp_${"B".repeat(43)}`, headers)).status).toBe(410);
    expect((await redeem(`zkp_${"B".repeat(43)}`, headers)).status).toBe(429);
  });
});

describe("app attestation on redeem", () => {
  async function redeemWith(code: string, overrides: Record<string, unknown>) {
    const request = workerRequest("https://api.test/v1/pairing/redeem", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "10.77.0.1" },
      body: JSON.stringify({ code }),
    });
    return worker.fetch(request, { ...env, ...overrides });
  }

  it("required (production): no attestation → 403, and the code stays usable", async () => {
    const { parent, family, kid } = await parentWithKid();
    const { code } = await pair(parent.auth, family.id, kid.id);
    const res = await redeemWith(code, { ATTESTATION_POLICY: "required" });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("attestation_failed");
    expect((await redeem(code)).status).toBe(200);
  });

  it("allowlist (staging): no attestation only for a code from an allowlisted test parent", async () => {
    const { parent, family, kid } = await parentWithKid("ana");
    const { code } = await pair(parent.auth, family.id, kid.id);
    const refused = await redeemWith(code, { ATTESTATION_POLICY: "allowlist", ATTESTATION_ALLOWLIST: "apple:bob" });
    expect(refused.status).toBe(403);
    const allowed = await redeemWith(code, { ATTESTATION_POLICY: "allowlist", ATTESTATION_ALLOWLIST: "apple:ana" });
    expect(allowed.status).toBe(200);
  });
});
