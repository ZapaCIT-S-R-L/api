// Test-only account service: an ES256 key generated per test file, chat tokens signed with it, and a fetch stub
// that serves its public key at ACCOUNT_JWKS_URL (top-level vars of wrangler.jsonc). No real key is ever used.
import { applyEvent, type MembershipEvent } from "../../src/membership";
import { noRooms, type Rooms } from "../../src/rooms";
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import { vi } from "vitest";
import worker from "../../src/index";

export const JWKS_URL = "http://127.0.0.1:8789/.well-known/jwks.json";
export const ISSUER = "http://localhost:8787";
export const AUDIENCE = "chat.localhost";

export interface Issuer {
  kid: string;
  jwk: JWK;
  sign(claims: JWTPayload, options?: { alg?: string; kid?: string; lifetime?: number; iat?: number }): Promise<string>;
}

let counter = 0;

export async function makeIssuer(kid = `chat-test-${++counter}`): Promise<Issuer> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
  return {
    kid,
    jwk,
    sign: (claims, options = {}) => {
      const iat = options.iat ?? Math.floor(Date.now() / 1000);
      return new SignJWT(claims)
        .setProtectedHeader({ alg: options.alg ?? "ES256", kid: options.kid ?? kid })
        .setIssuedAt(iat)
        .setExpirationTime(iat + (options.lifetime ?? 600))
        .sign(privateKey);
    },
  };
}

export interface JwksStub {
  keys: JWK[];
  calls: number;
  fail: boolean;
}

// Serves `issuers` at the JWKS URL; any other fetch fails the test.
export function stubJwks(...issuers: Issuer[]): JwksStub {
  const stub: JwksStub = { keys: issuers.map((i) => i.jwk), calls: 0, fail: false };
  vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url !== JWKS_URL) return Promise.reject(new Error(`unexpected fetch ${url}`));
    stub.calls++;
    if (stub.fail) return Promise.resolve(new Response("down", { status: 503 }));
    return Promise.resolve(Response.json({ keys: stub.keys }));
  });
  return stub;
}

export function claims(accountId: string, overrides: Record<string, unknown> = {}): JWTPayload {
  return { iss: ISSUER, aud: [AUDIENCE, "calls.localhost"], sub: accountId, dev: 1, role: "parent", ...overrides };
}

export async function tokenFor(issuer: Issuer, accountId: string, overrides: Record<string, unknown> = {}) {
  return issuer.sign(claims(accountId, overrides));
}

export function call(path: string, init: RequestInit = {}): Promise<Response> {
  const request = new Request(`https://chat.zapakid.test${path}`, init) as Parameters<typeof worker.fetch>[0];
  return worker.fetch(request, env);
}

export function as(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  return call(path, { ...init, headers });
}

let eventCounter = 0;

// A membership event with a fresh id.
export function event(body: Record<string, unknown>): MembershipEvent {
  eventCounter++;
  const id = `00000000-0000-4000-8000-${eventCounter.toString(16).padStart(12, "0")}`;
  return { v: 1, id, occurredAt: new Date().toISOString(), ...body } as MembershipEvent;
}

export async function apply(rooms: Rooms, ...bodies: Record<string, unknown>[]): Promise<void> {
  for (const body of bodies) await applyEvent(env, rooms, event(body));
}

// Two families, connected: Mum + Dad + kid Alex (fam1); Ana (parent) + kid Maria (fam2). One device each.
export const MUM = "acc_mum";
export const DAD = "acc_dad";
export const ALEX = "acc_alex";
export const ANA = "acc_ana";
export const MARIA = "acc_maria";
export const STRANGER = "acc_stranger";

export async function seedFamilies(rooms: Rooms = noRooms, { connect = true, share = true } = {}): Promise<void> {
  await apply(
    rooms,
    { type: "family.member_added", familyId: "fam1", accountId: MUM, role: "parent" },
    { type: "family.member_added", familyId: "fam1", accountId: DAD, role: "parent" },
    { type: "family.member_added", familyId: "fam1", accountId: ALEX, role: "kid" },
    { type: "family.member_added", familyId: "fam2", accountId: ANA, role: "parent" },
    { type: "family.member_added", familyId: "fam2", accountId: MARIA, role: "kid" },
    { type: "family.member_added", familyId: "fam3", accountId: STRANGER, role: "parent" },
  );
  for (const [i, account] of [MUM, DAD, ALEX, ANA, MARIA, STRANGER].entries()) {
    await apply(rooms, { type: "device.upserted", accountId: account, deviceId: 1, registrationId: 100 + i });
  }
  if (connect) {
    await apply(rooms, { type: "connection.created", connectionId: "con12", familyIds: ["fam2", "fam1"] });
    if (share) {
      await apply(
        rooms,
        { type: "connection.kid_shared", connectionId: "con12", kidAccountId: ALEX },
        { type: "connection.kid_shared", connectionId: "con12", kidAccountId: MARIA },
      );
    }
  }
}

export interface ConversationBody {
  id: string;
  kind: string;
  state: string;
  closedAt: string | null;
  members: {
    accountId: string;
    role: string;
    guardian: boolean;
    devices: { deviceId: number; registrationId: number }[];
  }[];
}

export function memberIds(c: ConversationBody): string[] {
  return c.members.map((m) => m.accountId).sort();
}

// Records what the conversation logic asked of the live side.
export function recordingRooms(): Rooms & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    notify: (id, kind, removed) => {
      log.push(`notify ${id} ${kind}${removed.length ? ` -${removed.join(",")}` : ""}`);
      return Promise.resolve();
    },
    forgetAccount: (id, account) => {
      log.push(`forgetAccount ${id} ${account}`);
      return Promise.resolve();
    },
    forgetDevice: (id, account, device) => {
      log.push(`forgetDevice ${id} ${account}:${device}`);
      return Promise.resolve();
    },
    purge: (id) => {
      log.push(`purge ${id}`);
      return Promise.resolve();
    },
  };
}
