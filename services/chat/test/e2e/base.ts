// Shared helpers for the end-to-end tests against a running chat Worker. LIVE=1 means a deployed environment: only
// checks that need no valid token or test hook run there.
// Locally (wrangler dev, top-level vars of wrangler.jsonc), the tests play the account service: they serve an ES256
// key set on 127.0.0.1:8789 (global-setup.ts) and sign chat tokens with it, and they feed membership events through the local-only
// POST /__e2e/membership hook into the real queue consumer.
import { importJWK, SignJWT, type JWTPayload } from "jose";
import { inject } from "vitest";

export const CHAT_URL = (process.env.CHAT_URL ?? "http://127.0.0.1:8790").replace(/\/$/, "");
if (!/^https?:\/\/[^/]+$/.test(CHAT_URL)) throw new Error(`CHAT_URL must be an http(s) origin, got "${CHAT_URL}"`);
export const LIVE = process.env.LIVE === "1";

export function chat(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${CHAT_URL}${path}`, { redirect: "manual", ...init });
}

export interface AccountService {
  sign(claims: JWTPayload, lifetime?: number): Promise<string>;
  close(): Promise<void>;
}

// Signs chat tokens with the run's fake account service key (test/e2e/global-setup.ts serves its public half).
export async function fakeAccountService(): Promise<AccountService> {
  const jwk = inject("accountKey");
  const key = await importJWK(jwk, "ES256");
  return {
    sign: (claims, lifetime = 600) => {
      const iat = Math.floor(Date.now() / 1000);
      return new SignJWT({
        iss: "http://localhost:8787",
        aud: ["chat.localhost", "calls.localhost"],
        dev: 1,
        role: "parent",
        ...claims,
      })
        .setProtectedHeader({ alg: "ES256", kid: jwk.kid ?? "" })
        .setIssuedAt(iat)
        .setExpirationTime(iat + lifetime)
        .sign(key);
    },
    close: () => Promise.resolve(),
  };
}

export function bearer(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

export const run = Date.now().toString(36);
let counter = 0;

export function membershipEvent(body: Record<string, unknown>): Record<string, unknown> {
  counter++;
  const hex = (Date.now() * 1000 + counter).toString(16).padStart(12, "0").slice(-12);
  return { v: 1, id: `00000000-0000-4000-8000-${hex}`, occurredAt: new Date().toISOString(), ...body };
}

export async function sendMembership(events: Record<string, unknown>[]): Promise<void> {
  const res = await chat("/__e2e/membership", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: events.map(membershipEvent) }),
  });
  if (res.status !== 202) throw new Error(`/__e2e/membership answered ${res.status}`);
}

// Retries `check` until it returns true (queue delivery is asynchronous).
export async function eventually(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// Two connected families with one device per account, unique to this run.
export function family(prefix = run) {
  const id = (name: string) => `e2e_${prefix}_${name}`;
  return {
    mum: id("mum"),
    dad: id("dad"),
    alex: id("alex"),
    ana: id("ana"),
    maria: id("maria"),
    fam1: id("fam1"),
    fam2: id("fam2"),
    con: id("con"),
  };
}

export async function seedFamily(f: ReturnType<typeof family>): Promise<void> {
  const accounts = [f.mum, f.dad, f.alex, f.ana, f.maria];
  await sendMembership([
    { type: "family.member_added", familyId: f.fam1, accountId: f.mum, role: "parent" },
    { type: "family.member_added", familyId: f.fam1, accountId: f.dad, role: "parent" },
    { type: "family.member_added", familyId: f.fam1, accountId: f.alex, role: "kid" },
    { type: "family.member_added", familyId: f.fam2, accountId: f.ana, role: "parent" },
    { type: "family.member_added", familyId: f.fam2, accountId: f.maria, role: "kid" },
    { type: "connection.created", connectionId: f.con, familyIds: [f.fam1, f.fam2] },
    { type: "connection.kid_shared", connectionId: f.con, kidAccountId: f.alex },
    { type: "connection.kid_shared", connectionId: f.con, kidAccountId: f.maria },
    ...accounts.map((accountId, i) => ({ type: "device.upserted", accountId, deviceId: 1, registrationId: 200 + i })),
  ]);
}
