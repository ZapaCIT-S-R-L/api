// Kid phones in the key directory, end to end over HTTP (local only: needs test sign-in keys). A parent pairs a
// kid's phone; the kid registers its device and keys, both fetch each other's prekey bundles, the kid gets a chat
// token; another family's parent and kid are refused; unpairing and removing the kid revoke its phone.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { api, bodyOf, LIVE } from "./base";
import { post, signInParent, type SignedInParent } from "./identity";

const run = Date.now().toString(36);

const typed = (type: number, length: number) => {
  const bytes = randomBytes(length);
  bytes[0] = type;
  return bytes.toString("base64");
};
const ec = () => typed(0x05, 33);
const kyber = () => typed(0x08, 1569);
const sig = () => randomBytes(64).toString("base64");

const deviceKeys = (identityKey = ec()) => ({
  registrationId: 1000 + Math.floor(Math.random() * 1000),
  identityKey,
  signedPreKey: { keyId: 1, publicKey: ec(), signature: sig() },
  pqLastResortPreKey: { keyId: 1, publicKey: kyber(), signature: sig() },
  preKeys: [1, 2, 3].map((keyId) => ({ keyId, publicKey: ec() })),
  pqPreKeys: [2, 3].map((keyId) => ({ keyId, publicKey: kyber(), signature: sig() })),
});

const get = (path: string, auth: Record<string, string>) => api(path, { headers: auth });
const del = (path: string, auth: Record<string, string>) => api(path, { method: "DELETE", headers: auth });

async function familyWithKid(parent: SignedInParent, nickname: string) {
  const family = await bodyOf<{ id: string }>(await post("/v1/families", {}, parent.auth));
  const kid = await bodyOf<{ id: string }>(
    await post(`/v1/families/${family.id}/kids`, { nickname, avatar: "robot-3", grade: 2 }, parent.auth),
  );
  return { familyId: family.id, kidId: kid.id };
}

async function pair(parent: SignedInParent, familyId: string, kidId: string): Promise<Record<string, string>> {
  const { code } = await bodyOf<{ code: string }>(
    await post(`/v1/families/${familyId}/kids/${kidId}/pairing`, {}, parent.auth),
  );
  const res = await post("/v1/pairing/redeem", { code });
  expect(res.status).toBe(200);
  const { session } = await bodyOf<{ session: { token: string } }>(res);
  return { authorization: `Bearer ${session.token}` };
}

describe.skipIf(LIVE)("kid devices and keys (local only)", () => {
  it("a paired kid registers, exchanges bundles with its parent, gets a chat token; unpair and remove revoke it", async () => {
    const ana = await signInParent(`kd-ana-${run}`, "Ana");
    const bob = await signInParent(`kd-bob-${run}`, "Bob");
    const { familyId, kidId } = await familyWithKid(ana, "Mia");
    const bobs = await familyWithKid(bob, "Tom");
    const kid = await pair(ana, familyId, kidId);
    const tom = await pair(bob, bobs.familyId, bobs.kidId);

    const kidKeys = deviceKeys();
    const registered = await post("/v1/devices", kidKeys, kid);
    expect(registered.status).toBe(201);
    expect(await bodyOf<{ deviceId: number }>(registered)).toEqual({ deviceId: 1 });
    expect((await post("/v1/devices", deviceKeys(), ana.auth)).status).toBe(201);
    expect((await post("/v1/devices", deviceKeys(), tom)).status).toBe(201);
    expect(await bodyOf(await get("/v1/keys/prekeys", kid))).toEqual({ preKeys: 3, pqPreKeys: 2 });

    const kidBundle = await get(`/v1/keys/${kidId}/*`, ana.auth);
    expect(kidBundle.status).toBe(200);
    const body = await bodyOf<{ identityKey: string; devices: { deviceId: number; registrationId: number }[] }>(
      kidBundle,
    );
    expect(body.identityKey).toBe(kidKeys.identityKey);
    expect(body.devices.map((d) => [d.deviceId, d.registrationId])).toEqual([[1, kidKeys.registrationId]]);
    expect((await get(`/v1/keys/${ana.id}/1`, kid)).status).toBe(200);

    // Outside the kid's family and connections.
    expect((await get(`/v1/keys/${bob.id}/*`, kid)).status).toBe(403);
    expect((await get(`/v1/keys/${bobs.kidId}/*`, kid)).status).toBe(403);
    expect((await get(`/v1/keys/${kidId}/*`, bob.auth)).status).toBe(403);
    expect((await get(`/v1/keys/${kidId}/*`, tom)).status).toBe(403);

    const token = await post("/v1/chat/token", {}, kid);
    expect(token.status).toBe(200);
    const jwt = (await bodyOf<{ token: string }>(token)).token;
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({ sub: kidId, role: "kid", dev: 1, conv: [`family:${familyId}`] });

    // Unpair: the phone is signed out and its device is gone; the kid stays in the family.
    expect((await del(`/v1/families/${familyId}/kids/${kidId}/pairing`, ana.auth)).status).toBe(204);
    expect((await get("/v1/families", kid)).status).toBe(401);
    expect((await get(`/v1/keys/${kidId}/1`, ana.auth)).status).toBe(404);

    // A new phone for the kid, then removing the kid: the new phone is signed out too.
    const again = await pair(ana, familyId, kidId);
    expect((await post("/v1/devices", { ...deviceKeys(kidKeys.identityKey) }, again)).status).toBe(201);
    expect((await del(`/v1/families/${familyId}/kids/${kidId}`, ana.auth)).status).toBe(204);
    expect((await get("/v1/families", again)).status).toBe(401);
    expect((await get(`/v1/keys/${kidId}/*`, ana.auth)).status).toBe(403);
  });
});
