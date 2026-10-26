// A fake App Attest world for tests: a root CA standing in for Apple's (P-384), an intermediate, and a device whose
// Secure Enclave key (P-256) gets a leaf certificate with Apple's nonce extension, attestation objects and
// assertions in Apple's formats (CBOR, DER signatures). Everything is generated per test run; nothing is real.
import * as asn1js from "asn1js";
import { encode } from "cborg";
import * as pkijs from "pkijs";

const engine = new pkijs.CryptoEngine({ name: "workerd-tests", crypto }) as unknown as pkijs.ICryptoEngine;

export const APP_ID = "9572LYGZ7S.ro.zapakid.app";
const NONCE_OID = "1.2.840.113635.100.8.2";
const P384 = { name: "ECDSA", namedCurve: "P-384" } as const;
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

const sha256 = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", data));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
export const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const utf8 = (s: string) => new TextEncoder().encode(s);

let serial = 1;

async function certificate(options: {
  subject: string;
  issuer: string;
  publicKey: CryptoKey;
  signingKey: CryptoKey;
  hash: "SHA-256" | "SHA-384";
  ca: boolean;
  extensions?: pkijs.Extension[];
  notAfter?: Date;
}): Promise<pkijs.Certificate> {
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: serial++ });
  const name = (cn: string) =>
    new pkijs.RelativeDistinguishedNames({
      typesAndValues: [
        new pkijs.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.Utf8String({ value: cn }) }),
      ],
    });
  cert.subject = name(options.subject);
  cert.issuer = name(options.issuer);
  cert.notBefore.value = new Date(Date.now() - 86_400_000);
  cert.notAfter.value = options.notAfter ?? new Date(Date.now() + 365 * 86_400_000);
  await cert.subjectPublicKeyInfo.importKey(options.publicKey, engine);
  cert.extensions = [
    new pkijs.Extension({
      extnID: "2.5.29.19",
      critical: true,
      extnValue: new pkijs.BasicConstraints({ cA: options.ca }).toSchema().toBER(false),
    }),
    ...(options.extensions ?? []),
  ];
  await cert.sign(options.signingKey, options.hash, engine);
  return cert;
}

const der = (cert: pkijs.Certificate) => new Uint8Array(cert.toSchema().toBER(false));

export interface FakeApple {
  rootDer: Uint8Array;
  intermediate: pkijs.Certificate;
  intermediateKeys: CryptoKeyPair;
}

export async function fakeApple(): Promise<FakeApple> {
  const rootKeys = (await crypto.subtle.generateKey(P384, true, ["sign", "verify"])) as CryptoKeyPair;
  const root = await certificate({
    subject: "Test App Attestation Root CA",
    issuer: "Test App Attestation Root CA",
    publicKey: rootKeys.publicKey,
    signingKey: rootKeys.privateKey,
    hash: "SHA-384",
    ca: true,
  });
  const intermediateKeys = (await crypto.subtle.generateKey(P384, true, ["sign", "verify"])) as CryptoKeyPair;
  const intermediate = await certificate({
    subject: "Test App Attestation CA 1",
    issuer: "Test App Attestation Root CA",
    publicKey: intermediateKeys.publicKey,
    signingKey: rootKeys.privateKey,
    hash: "SHA-384",
    ca: true,
  });
  return { rootDer: der(root), intermediate, intermediateKeys };
}

export interface AttestOptions {
  appId?: string;
  counter?: number;
  aaguid?: "appattestdevelop" | "appattest";
  nonce?: Uint8Array; // put this in the certificate instead of the right nonce
  keyId?: Uint8Array; // claim this key id instead of the real one
  credentialId?: Uint8Array;
  fmt?: string;
  expired?: boolean;
  issuer?: FakeApple; // sign the leaf with another CA
}

export class FakeDevice {
  counter = 0;
  private constructor(
    readonly keys: CryptoKeyPair,
    readonly keyIdBytes: Uint8Array,
    private readonly apple: FakeApple,
  ) {}

  static async create(apple: FakeApple): Promise<FakeDevice> {
    const keys = (await crypto.subtle.generateKey(P256, true, ["sign", "verify"])) as CryptoKeyPair;
    const point = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
    return new FakeDevice(keys, await sha256(point), apple);
  }

  get keyId(): string {
    return b64(this.keyIdBytes);
  }

  private aaguid(kind: "appattestdevelop" | "appattest"): Uint8Array {
    const out = new Uint8Array(16);
    out.set(utf8(kind));
    return out;
  }

  // attestKey(keyId, clientDataHash: SHA-256(challenge)), as base64 of the CBOR attestation object.
  async attest(challenge: string, options: AttestOptions = {}): Promise<string> {
    const rpIdHash = await sha256(utf8(options.appId ?? APP_ID));
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, options.counter ?? 0);
    const credentialId = options.credentialId ?? this.keyIdBytes;
    const length = new Uint8Array(2);
    new DataView(length.buffer).setUint16(0, credentialId.length);
    const authData = concat(
      rpIdHash,
      new Uint8Array([0x40]),
      counter,
      this.aaguid(options.aaguid ?? "appattestdevelop"),
      length,
      credentialId,
      encode(
        new Map<number, unknown>([
          [1, 2],
          [3, -7],
        ]),
      ), // a COSE key stub; the server reads the certificate
    );
    const clientDataHash = await sha256(utf8(challenge));
    const nonce = options.nonce ?? (await sha256(concat(authData, clientDataHash)));
    const nonceExtension = new asn1js.Sequence({
      value: [
        new asn1js.Constructed({
          idBlock: { tagClass: 3, tagNumber: 1 },
          value: [new asn1js.OctetString({ valueHex: nonce })],
        }),
      ],
    });
    const issuer = options.issuer ?? this.apple;
    const leaf = await certificate({
      subject: options.keyId ? b64(options.keyId) : this.keyId,
      issuer: "Test App Attestation CA 1",
      publicKey: this.keys.publicKey,
      signingKey: issuer.intermediateKeys.privateKey,
      hash: "SHA-384",
      ca: false,
      extensions: [new pkijs.Extension({ extnID: NONCE_OID, critical: false, extnValue: nonceExtension.toBER(false) })],
      ...(options.expired ? { notAfter: new Date(Date.now() - 3_600_000) } : {}),
    });
    const attestation = encode({
      fmt: options.fmt ?? "apple-appattest",
      attStmt: { x5c: [der(leaf), der(issuer.intermediate)], receipt: new Uint8Array([1, 2, 3]) },
      authData,
    });
    return b64(attestation);
  }

  // generateAssertion(keyId, clientDataHash: SHA-256(body)) → the ZapaKid-Attestation header value.
  async assert(body: string, options: { appId?: string; counter?: number; key?: CryptoKey } = {}): Promise<string> {
    this.counter = options.counter ?? this.counter + 1;
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, this.counter);
    const authenticatorData = concat(await sha256(utf8(options.appId ?? APP_ID)), new Uint8Array([0x40]), counter);
    const nonce = await sha256(concat(authenticatorData, await sha256(utf8(body))));
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, options.key ?? this.keys.privateKey, nonce),
    );
    const assertion = encode({ signature: derSignature(raw), authenticatorData });
    return `v1 keyId=${this.keyId} assertion=${b64(assertion)}`;
  }
}

// WebCrypto signs ECDSA as r‖s; Apple sends DER SEQUENCE { INTEGER r, INTEGER s }.
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (bytes: Uint8Array) => {
    let b = bytes;
    while (b.length > 1 && b[0] === 0 && (b[1] ?? 0) < 0x80) b = b.slice(1);
    return new asn1js.Integer({ valueHex: (b[0] ?? 0) >= 0x80 ? concat(new Uint8Array([0]), b) : b });
  };
  return new Uint8Array(new asn1js.Sequence({ value: [int(raw.slice(0, 32)), int(raw.slice(32))] }).toBER(false));
}
