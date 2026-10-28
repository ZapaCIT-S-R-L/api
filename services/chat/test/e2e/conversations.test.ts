// Tokens and conversations over HTTP. Locally the full flow runs (fake account service keys, membership events via
// the queue); against a deployed environment only the token checks that need no valid token.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, chat, eventually, family, fakeAccountService, LIVE, seedFamily, type AccountService } from "./base";

let account: AccountService;
const f = family();

beforeAll(async () => {
  account = await fakeAccountService();
  if (!LIVE) await seedFamily(f);
});

afterAll(async () => {
  await account.close();
});

const post = (token: string, path: string, body: unknown) =>
  chat(path, {
    method: "POST",
    headers: bearer(token, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });

describe("chat tokens", () => {
  it("no token: 401", async () => {
    const res = await chat("/v1/conversations");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("a token from the (fake) account service: 200 locally, 401 when deployed (our test key is unknown there)", async () => {
    const res = await chat("/v1/conversations", { headers: bearer(await account.sign({ sub: f.mum })) });
    // Deployed: our test key is unknown (401), or the account service doesn't publish its keys yet (503).
    if (LIVE) expect([401, 503]).toContain(res.status);
    else expect(res.status).toBe(200);
  });

  it.skipIf(LIVE)("wrong audience and too long-lived tokens: 401", async () => {
    const wrongAud = await account.sign({ sub: f.mum, aud: "calls.localhost" });
    expect((await chat("/v1/conversations", { headers: bearer(wrongAud) })).status).toBe(401);
    const tooLong = await account.sign({ sub: f.mum }, 3600);
    expect((await chat("/v1/conversations", { headers: bearer(tooLong) })).status).toBe(401);
  });
});

describe.skipIf(LIVE)("conversations", () => {
  it("a parent starts a chat with their kid; the other parent is in it; the kid sees it", async () => {
    const mum = await account.sign({ sub: f.mum });
    let res: Response | undefined;
    await eventually(async () => {
      res = await post(mum, "/v1/conversations", { members: [f.alex] });
      return res.status !== 403;
    });
    expect(res?.status).toBe(201);
    const conversation = (await res?.json()) as { id: string; members: { accountId: string; guardian: boolean }[] };
    expect(conversation.members.map((m) => m.accountId).sort()).toEqual([f.alex, f.dad, f.mum].sort());

    const kid = await account.sign({ sub: f.alex, role: "kid" });
    const list = (await (await chat("/v1/conversations", { headers: bearer(kid) })).json()) as {
      conversations: { id: string }[];
    };
    expect(list.conversations.map((c) => c.id)).toContain(conversation.id);
    expect((await post(kid, "/v1/conversations", { members: [f.mum] })).status).toBe(403);
  });

  it("a group with the connected family's shared kid includes that kid's parent", async () => {
    const mum = await account.sign({ sub: f.mum });
    let res: Response | undefined;
    await eventually(async () => {
      res = await post(mum, "/v1/conversations", { members: [f.alex, f.maria] });
      return res.status !== 403;
    });
    expect(res?.status).toBe(201);
    const body = (await res?.json()) as { kind: string; members: { accountId: string }[] };
    expect(body.kind).toBe("group");
    expect(body.members.map((m) => m.accountId)).toContain(f.ana);
  });
});
