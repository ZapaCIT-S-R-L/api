// Attachments end to end over the one-time URLs (local only: needs the fake account service and the hook).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, chat, eventually, family, fakeAccountService, LIVE, seedFamily, type AccountService } from "./base";

let account: AccountService;
const f = family(`${Date.now().toString(36)}a`);

beforeAll(async () => {
  account = await fakeAccountService();
  if (!LIVE) await seedFamily(f);
});

afterAll(async () => {
  await account.close();
});

describe.skipIf(LIVE)("attachments", () => {
  it("uploads ciphertext once and downloads it once", async () => {
    const mum = await account.sign({ sub: f.mum });
    let id = "";
    await eventually(async () => {
      const res = await chat("/v1/conversations", {
        method: "POST",
        headers: bearer(mum, { "content-type": "application/json" }),
        body: JSON.stringify({ members: [f.ana] }),
      });
      if (res.status >= 300) return false;
      // Devices arrive through the membership queue like everything else; reserving needs a registered device.
      const c = (await res.json()) as { id: string; members: { devices: unknown[] }[] };
      id = c.id;
      return c.members.every((m) => m.devices.length > 0);
    });
    const bytes = new Uint8Array(4096).map((_, i) => (i * 31) % 256);
    const reserved = await chat("/v1/attachments", {
      method: "POST",
      headers: bearer(mum, { "content-type": "application/json" }),
      body: JSON.stringify({ conversationId: id, size: bytes.length }),
    });
    expect(reserved.status).toBe(201);
    const { attachmentId, uploadUrl } = (await reserved.json()) as { attachmentId: string; uploadUrl: string };
    expect((await fetch(uploadUrl, { method: "PUT", body: bytes })).status).toBe(204);
    expect((await fetch(uploadUrl, { method: "PUT", body: bytes })).status).toBe(404);

    const ana = await account.sign({ sub: f.ana });
    const meta = (await (await chat(`/v1/attachments/${attachmentId}`, { headers: bearer(ana) })).json()) as {
      downloadUrl: string;
    };
    const download = await fetch(meta.downloadUrl);
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
    expect((await fetch(meta.downloadUrl)).status).toBe(404);
  });
});
