// Encrypted attachments: one-time upload and download URLs, members only, gone with the conversation.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ABANDONED_MS, purgeAbandonedAttachments } from "../../src/attachments";
import { applyEvent } from "../../src/membership";
import { durableRooms } from "../../src/room";
import {
  ALEX,
  ANA,
  DAD,
  as,
  call,
  event,
  makeIssuer,
  MUM,
  seedFamilies,
  stubJwks,
  tokenFor,
  type ConversationBody,
  type Issuer,
} from "./helpers";

let issuer: Issuer;
const tok = (account: string, dev = 1) => tokenFor(issuer, account, { dev });
const BYTES = new Uint8Array([1, 2, 3, 250, 251, 252, 0, 7]);

beforeEach(async () => {
  issuer = await makeIssuer();
  stubJwks(issuer);
  await seedFamilies(durableRooms(env));
});

async function conversation(): Promise<ConversationBody> {
  const res = await as(await tok(MUM), "/v1/conversations", {
    method: "POST",
    body: JSON.stringify({ members: [ANA] }),
  });
  return res.json<ConversationBody>();
}

async function reserve(c: ConversationBody, account = MUM, size = BYTES.length) {
  return as(await tok(account), "/v1/attachments", {
    method: "POST",
    body: JSON.stringify({ conversationId: c.id, size }),
  });
}

// Relative path of a one-time URL (the tests call the Worker directly).
const path = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

const put = (url: string, body: Uint8Array = BYTES) =>
  call(path(url), { method: "PUT", body, headers: { "content-length": String(body.length) } });

async function uploaded(c: ConversationBody): Promise<string> {
  const { attachmentId, uploadUrl } = await (await reserve(c)).json<{ attachmentId: string; uploadUrl: string }>();
  expect((await put(uploadUrl)).status).toBe(204);
  return attachmentId;
}

describe("attachments", () => {
  it("upload once, download once, bytes unchanged", async () => {
    const c = await conversation();
    const res = await reserve(c);
    expect(res.status).toBe(201);
    const { attachmentId, uploadUrl, expiresAt } = await res.json<{
      attachmentId: string;
      uploadUrl: string;
      expiresAt: string;
    }>();
    expect(attachmentId).toMatch(/^a_[A-Za-z0-9_-]{22}$/);
    expect(uploadUrl).toMatch(/^https:\/\/chat\.zapakid\.test\/v1\/attachments\/a_[\w-]{22}\/upload\?token=[\w-]{43}$/);
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);

    expect((await put(uploadUrl)).status).toBe(204);
    expect((await put(uploadUrl)).status).toBe(404);

    const meta = await as(await tok(ANA), `/v1/attachments/${attachmentId}`);
    expect(meta.status).toBe(200);
    const { downloadUrl, size } = await meta.json<{ downloadUrl: string; size: number }>();
    expect(size).toBe(BYTES.length);
    const download = await call(path(downloadUrl));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(BYTES);
    expect((await call(path(downloadUrl))).status).toBe(404);
  });

  it("members only: others can't reserve or get a download URL", async () => {
    const c = await conversation();
    expect((await reserve(c, ALEX)).status).toBe(404);
    const id = await uploaded(c);
    expect((await as(await tok(ALEX), `/v1/attachments/${id}`)).status).toBe(404);
    expect((await as(await tok(MUM), "/v1/attachments/a_0000000000000000000000")).status).toBe(404);
  });

  it("no uploads into a closed conversation", async () => {
    const c = await conversation();
    await applyEvent(env, durableRooms(env), event({ type: "connection.removed", connectionId: "con12" }));
    expect((await reserve(c)).status).toBe(403);
  });

  it("an observer (a kid's parent reading the chat, #73) can't reserve an upload", async () => {
    const res = await as(await tok(MUM), "/v1/conversations", {
      method: "POST",
      body: JSON.stringify({ members: [ALEX] }),
    });
    const c = await res.json<ConversationBody>();
    expect(c.members.find((m) => m.accountId === DAD)?.role).toBe("observer");
    const refused = await reserve(c, DAD);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "observer_read_only" } });
  });

  it("the body must be exactly the reserved size; size is capped at 25 MiB", async () => {
    const c = await conversation();
    expect((await reserve(c, MUM, 25 * 1024 * 1024 + 1)).status).toBe(400);
    expect((await reserve(c, MUM, 0)).status).toBe(400);
    const { uploadUrl } = await (await reserve(c)).json<{ uploadUrl: string }>();
    expect((await put(uploadUrl, new Uint8Array(BYTES.length + 1))).status).toBe(413);
    expect((await put(uploadUrl, new Uint8Array(2))).status).toBe(400);
    // Refused attempts don't use up the URL.
    expect((await put(uploadUrl)).status).toBe(204);
  });

  it("a wrong or expired token is 404", async () => {
    const c = await conversation();
    const { attachmentId, uploadUrl } = await (await reserve(c)).json<{ attachmentId: string; uploadUrl: string }>();
    expect((await put(uploadUrl.replace(/token=.{4}/, "token=AAAA"))).status).toBe(404);
    await env.DB.prepare("UPDATE attachments SET upload_expires_at = 0 WHERE id = ?1").bind(attachmentId).run();
    expect((await put(uploadUrl)).status).toBe(404);
  });

  it("deleted with the conversation once every member deleted it", async () => {
    const c = await conversation();
    const id = await uploaded(c);
    expect(await env.ATTACHMENTS.head(id)).not.toBeNull();
    await as(await tok(MUM), `/v1/conversations/${c.id}`, { method: "DELETE" });
    expect(await env.ATTACHMENTS.head(id)).not.toBeNull();
    await as(await tok(ANA), `/v1/conversations/${c.id}`, { method: "DELETE" });
    expect(await env.ATTACHMENTS.head(id)).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM attachments WHERE id = ?1").bind(id).first()).toBeNull();
  });

  it("the hourly purge removes abandoned reservations and expired download URLs", async () => {
    const c = await conversation();
    const kept = await uploaded(c);
    const { attachmentId: abandoned } = await (await reserve(c)).json<{ attachmentId: string }>();
    await (await as(await tok(ANA), `/v1/attachments/${kept}`)).json();
    await purgeAbandonedAttachments(env, Date.now() + ABANDONED_MS + 1000);
    const ids = await env.DB.prepare("SELECT id FROM attachments").all<{ id: string }>();
    expect(ids.results.map((r) => r.id)).toEqual([kept]);
    expect(abandoned).not.toBe(kept);
    expect(await env.DB.prepare("SELECT 1 FROM attachment_downloads").first()).toBeNull();
  });
});
