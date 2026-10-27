// Apple App Attest (iOS), verified as Apple documents it ("Validating apps that connect to your server"):
// 1. Registration: POST /v1/attestation/challenge, then POST /v1/attestation/apple with the attestation object for
//    clientDataHash = SHA-256(challenge). Checked: the certificate chain to Apple's App Attestation Root CA (pinned),
//    the nonce SHA-256(authData ‖ clientDataHash) in the leaf's extension 1.2.840.113635.100.8.2, keyId =
//    SHA-256(leaf public key), RP ID hash = SHA-256(APP_ATTEST_APP_ID), counter 0, the environment (aaguid), and
//    the credential id. The public key and counter are stored.
// 2. Every sign-in: `ZapaKid-Attestation: v1 keyId=<base64> assertion=<base64>`, an assertion for clientDataHash =
//    SHA-256(exact body). Checked: ECDSA P-256 signature over SHA-256(authenticatorData ‖ clientDataHash) with the
//    stored key, RP ID hash, and a counter above the stored one (stored atomically: no replay).
// Certificates are parsed and their signatures verified by pkijs, CBOR is decoded by cborg, all signatures and
// hashes are WebCrypto. The code here only compares values; it implements no cryptography.
import * as asn1js from "asn1js";
import { decode } from "cborg";
import * as pkijs from "pkijs";
import { APPLE_APP_ATTEST_ROOT_BASE64 } from "./app-attest-root";
import { invalid, onlyFields, readJson } from "./body";
import { randomBase64Url, sha256Hex } from "./crypto";
import type { Env } from "./env";
import { empty, error, json } from "./http";
import { AttestationFailed } from "./attestation-errors";

const NONCE_OID = "1.2.840.113635.100.8.2";
const CHALLENGE_TTL_SECONDS = 300;
const KEY_ID = /^[A-Za-z0-9+/]{43}=$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const HEADER = /^v1 keyId=([A-Za-z0-9+/]{43}=) assertion=([A-Za-z0-9+/]+={0,2})$/;

// pkijs verifies certificate signatures with the Workers WebCrypto, passed explicitly (no global engine).
// (Typed as ICryptoEngine: workers-types' SubtleCrypto adds timingSafeEqual, which pkijs doesn't use.)
const engine = new pkijs.CryptoEngine({ name: "workers", crypto }) as unknown as pkijs.ICryptoEngine;

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const sha256 = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", data));
const utf8 = (text: string) => new TextEncoder().encode(text);
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};
const fail = (reason: string): never => {
  throw new AttestationFailed(reason);
};

const APPLE_ROOT = fromBase64(APPLE_APP_ATTEST_ROOT_BASE64);
let root: Uint8Array = APPLE_ROOT;

// Tests only: trust a generated root instead of Apple's. Production code never calls this.
export function setAppAttestRootForTests(der: Uint8Array): void {
  root = der;
}

export function resetAppAttestRoot(): void {
  root = APPLE_ROOT;
}

const AAGUID = {
  development: utf8("appattestdevelop"),
  production: concat(utf8("appattest"), new Uint8Array(7)),
};

function allowedEnvironments(env: Env): string[] {
  return env.APP_ATTEST_ENVIRONMENTS.split(",").map((v) => v.trim());
}

export async function issueChallenge(env: Env): Promise<{ challenge: string; expiresAt: string }> {
  const challenge = randomBase64Url(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare("INSERT INTO app_attest_challenges (challenge_hash, created_at, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256Hex(challenge), now.toISOString(), expiresAt)
    .run();
  return { challenge, expiresAt };
}

function validAt(cert: pkijs.Certificate, now: Date): boolean {
  return cert.notBefore.value <= now && now <= cert.notAfter.value;
}

function isCa(cert: pkijs.Certificate): boolean {
  const ext = cert.extensions?.find((e) => e.extnID === "2.5.29.19");
  return (ext?.parsedValue as pkijs.BasicConstraints | undefined)?.cA === true;
}

// The leaf → intermediate → pinned root chain: signatures, validity, and the intermediate being a CA.
async function verifyChain(leaf: pkijs.Certificate, intermediate: pkijs.Certificate): Promise<void> {
  const trusted = pkijs.Certificate.fromBER(root);
  const now = new Date();
  if (!validAt(leaf, now) || !validAt(intermediate, now)) fail("certificate not valid now");
  if (!isCa(intermediate)) fail("intermediate is not a CA");
  if (!(await intermediate.verify(trusted, engine))) fail("intermediate not signed by the root");
  if (!(await leaf.verify(intermediate, engine))) fail("leaf not signed by the intermediate");
}

// SEQUENCE { [1] EXPLICIT OCTET STRING nonce } in the leaf's extension 1.2.840.113635.100.8.2.
function certificateNonce(leaf: pkijs.Certificate): Uint8Array {
  const ext = leaf.extensions?.find((e) => e.extnID === NONCE_OID) ?? fail("no nonce extension");
  const parsed = asn1js.fromBER(ext.extnValue.valueBlock.valueHexView);
  if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Sequence)) return fail("nonce extension malformed");
  const tagged = parsed.result.valueBlock.value[0];
  const octets = tagged instanceof asn1js.Constructed ? tagged.valueBlock.value[0] : undefined;
  if (!(octets instanceof asn1js.OctetString)) return fail("nonce extension malformed");
  return new Uint8Array(octets.valueBlock.valueHexView);
}

interface AttestationObject {
  fmt?: unknown;
  attStmt?: { x5c?: unknown };
  authData?: unknown;
}

export async function handleRegistration(body: Record<string, unknown>, env: Env): Promise<void> {
  onlyFields(body, ["keyId", "attestationObject", "challenge"], "the body");
  if (typeof body.keyId !== "string" || !KEY_ID.test(body.keyId)) throw invalid("keyId must be the base64 key id.");
  if (typeof body.challenge !== "string" || !CHALLENGE.test(body.challenge)) throw invalid("challenge is required.");
  if (typeof body.attestationObject !== "string" || body.attestationObject.length > 16384) {
    throw invalid("attestationObject must be base64.");
  }
  const keyId = body.keyId;
  const keyIdBytes = fromBase64(keyId);
  const challenge = body.challenge;

  // The challenge is used up first, whatever the attestation turns out to be.
  const consumed = await env.DB.prepare(
    "DELETE FROM app_attest_challenges WHERE challenge_hash = ? AND expires_at > ? RETURNING challenge_hash",
  )
    .bind(await sha256Hex(challenge), new Date().toISOString())
    .first();
  if (!consumed) fail("challenge unknown, expired or used");

  let object: AttestationObject;
  let leaf: pkijs.Certificate;
  let intermediate: pkijs.Certificate;
  try {
    object = decode(fromBase64(body.attestationObject)) as AttestationObject;
    const x5c = object.attStmt?.x5c;
    if (!Array.isArray(x5c) || !(x5c[0] instanceof Uint8Array) || !(x5c[1] instanceof Uint8Array)) throw new Error();
    leaf = pkijs.Certificate.fromBER(x5c[0]);
    intermediate = pkijs.Certificate.fromBER(x5c[1]);
  } catch {
    return fail("attestation object malformed");
  }
  if (object.fmt !== "apple-appattest") fail("format");
  const authData = object.authData;
  if (!(authData instanceof Uint8Array) || authData.length < 55) return fail("authData");

  await verifyChain(leaf, intermediate);

  const nonce = await sha256(concat(authData, await sha256(utf8(challenge))));
  if (!equal(certificateNonce(leaf), nonce)) fail("nonce");

  const point = new Uint8Array(leaf.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView);
  if (point.length !== 65 || point[0] !== 0x04) fail("leaf key is not an uncompressed P-256 point");
  if (!equal(await sha256(point), keyIdBytes)) fail("key id");

  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
  if (!equal(authData.slice(0, 32), await sha256(utf8(env.APP_ATTEST_APP_ID)))) fail("app id");
  if (view.getUint32(33) !== 0) fail("counter");
  const aaguid = authData.slice(37, 53);
  const environment = equal(aaguid, AAGUID.production)
    ? "production"
    : equal(aaguid, AAGUID.development)
      ? "development"
      : fail("aaguid");
  if (!allowedEnvironments(env).includes(environment)) fail(`${environment} keys not accepted here`);
  const credentialIdLength = view.getUint16(53);
  if (!equal(authData.slice(55, 55 + credentialIdLength), keyIdBytes)) fail("credential id");

  const inserted = await env.DB.prepare(
    `INSERT INTO app_attest_keys (key_id, public_key, counter, environment, created_at) VALUES (?, ?, 0, ?, ?)
     ON CONFLICT (key_id) DO NOTHING RETURNING key_id`,
  )
    .bind(keyId, toBase64(point), environment, new Date().toISOString())
    .first();
  if (!inserted) fail("key already registered");
}

// DER SEQUENCE { INTEGER r, INTEGER s } → r‖s, 32 bytes each, as WebCrypto expects.
function rawSignature(der: Uint8Array): Uint8Array {
  const parsed = asn1js.fromBER(der);
  if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Sequence)) return fail("signature malformed");
  const parts = parsed.result.valueBlock.value;
  if (parts.length !== 2) fail("signature malformed");
  const out = new Uint8Array(64);
  parts.forEach((part, i) => {
    if (!(part instanceof asn1js.Integer)) fail("signature malformed");
    let bytes = new Uint8Array((part as asn1js.Integer).valueBlock.valueHexView);
    while (bytes.length > 32 && bytes[0] === 0) bytes = bytes.slice(1);
    if (bytes.length > 32) fail("signature malformed");
    out.set(bytes, i * 32 + (32 - bytes.length));
  });
  return out;
}

// "v<version> ..." is the iOS format (only v1 exists); a Play Integrity token is base64url with dots, no spaces.
export function isAppAttestHeader(header: string): boolean {
  return /^v\d+(\s|$)/.test(header);
}

export async function verifyAssertion(header: string, bytes: Uint8Array, env: Env): Promise<void> {
  const match = HEADER.exec(header) ?? fail("header malformed");
  const keyId = match[1] ?? "";
  const assertionText = match[2] ?? "";
  const key = await env.DB.prepare("SELECT public_key, counter, environment FROM app_attest_keys WHERE key_id = ?")
    .bind(keyId)
    .first<{ public_key: string; counter: number; environment: string }>();
  if (!key) return fail("key not registered");
  if (!allowedEnvironments(env).includes(key.environment)) fail(`${key.environment} key not accepted here`);

  let signature: Uint8Array;
  let authenticatorData: Uint8Array;
  try {
    const assertion = decode(fromBase64(assertionText)) as { signature?: unknown; authenticatorData?: unknown };
    if (!(assertion.signature instanceof Uint8Array) || !(assertion.authenticatorData instanceof Uint8Array)) {
      throw new Error();
    }
    signature = assertion.signature;
    authenticatorData = assertion.authenticatorData;
  } catch {
    return fail("assertion malformed");
  }
  if (authenticatorData.length < 37) fail("authenticatorData");

  const nonce = await sha256(concat(authenticatorData, await sha256(bytes)));
  const publicKey = await crypto.subtle.importKey(
    "raw",
    fromBase64(key.public_key),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    rawSignature(signature),
    nonce,
  );
  if (!valid) fail("signature");
  if (!equal(authenticatorData.slice(0, 32), await sha256(utf8(env.APP_ATTEST_APP_ID)))) fail("app id");

  const counter = new DataView(authenticatorData.buffer, authenticatorData.byteOffset).getUint32(33);
  const updated = await env.DB.prepare(
    "UPDATE app_attest_keys SET counter = ?, last_used_at = ? WHERE key_id = ? AND counter < ?",
  )
    .bind(counter, new Date().toISOString(), keyId, counter)
    .run();
  if (updated.meta.changes !== 1) fail("counter did not increase (replay)");
}

export async function handleChallenge(_request: Request, env: Env): Promise<Response> {
  return json(await issueChallenge(env));
}

export async function handleAppleAttestation(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  try {
    await handleRegistration(body, env);
  } catch (e) {
    if (!(e instanceof AttestationFailed)) throw e;
    console.log(JSON.stringify({ msg: "app attest registration refused", reason: e.message }));
    return error(403, "attestation_failed", "This device couldn't prove it runs the genuine ZapaKid app.");
  }
  return empty(204);
}
