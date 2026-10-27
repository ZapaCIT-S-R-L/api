// Vitest globalSetup for the local e2e run: one loopback server (FAKE_PORT, 8798) that plays the account API's JWKS,
// Cloudflare's Realtime SFU and TURN key APIs, the way developers.cloudflare.com/realtime documents them, and the
// chat service's conversation members (under /chat: the tests set them, the chat stub Worker reads them). The
// calls Worker runs on wrangler dev with these URLs and fake credentials (scripts/check.sh, ci-calls.yml). The
// signing key is generated per run and handed to the tests (inject("issuerKey")). LIVE=1: nothing to fake.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import type { TestProject } from "vitest/node";

// The fake credentials wrangler dev gets (--var); the fake refuses anything else, so the tests prove the Worker
// sends the right secret to the right API.
export const FAKE_APP_ID = "e2e-app";
export const FAKE_APP_SECRET = "e2e-app-secret";
export const FAKE_TURN_KEY_ID = "e2e-turn";
export const FAKE_TURN_TOKEN = "e2e-turn-token";

declare module "vitest" {
  export interface ProvidedContext {
    issuerKey: JWK;
  }
}

let server: Server | undefined;

// conversationId → accountId → { role, devices }: what the chat service would answer (test/chat-stub/index.js).
const chats = new Map<string, Map<string, { role: string; devices: number[] }>>();

// /chat/members (PUT adds a device of a member, DELETE removes the member) and /chat/conversations/{id}.
function chat(method: string, url: string, body: Record<string, unknown>): [number, unknown] | null {
  if (url === "/chat/members") {
    const conversationId = String(body.conversationId);
    const accountId = String(body.accountId);
    if (method === "PUT") {
      const members = chats.get(conversationId) ?? new Map<string, { role: string; devices: number[] }>();
      chats.set(conversationId, members);
      const m = members.get(accountId) ?? { role: String(body.role ?? "parent"), devices: [] };
      if (!m.devices.includes(Number(body.deviceId))) m.devices.push(Number(body.deviceId));
      members.set(accountId, m);
      return [204, null];
    }
    if (method === "DELETE") {
      chats.get(conversationId)?.delete(accountId);
      return [204, null];
    }
  }
  const get = /^\/chat\/conversations\/([^/]+)$/.exec(url);
  if (get && method === "GET") {
    const members = chats.get(decodeURIComponent(get[1] ?? ""));
    if (!members) return [404, { error: "no such conversation" }];
    return [200, [...members.entries()].map(([accountId, m]) => ({ accountId, role: m.role, devices: m.devices }))];
  }
  return null;
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const kid = `e2e-${Date.now().toString(36)}`;
  project.provide("issuerKey", { ...(await exportJWK(privateKey)), kid, alg: "ES256" });
  if (process.env.LIVE === "1") return () => Promise.resolve();
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" }] };
  const port = Number(process.env.FAKE_PORT ?? 8798);

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const url = req.url ?? "";
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
      const auth = req.headers.authorization;
      const answered = url.startsWith("/chat/") ? chat(req.method ?? "GET", url, body) : null;
      if (answered) {
        if (answered[0] === 204) {
          res.writeHead(204);
          res.end();
        } else {
          send(answered[0], answered[1]);
        }
        return;
      }
      if (url === "/jwks") {
        send(200, jwks);
        return;
      }
      if (url === `/realtime/turn/keys/${FAKE_TURN_KEY_ID}/credentials/generate-ice-servers` && req.method === "POST") {
        if (auth !== `Bearer ${FAKE_TURN_TOKEN}`) {
          send(401, { error: "bad turn token" });
          return;
        }
        send(201, {
          iceServers: [
            { urls: ["stun:stun.cloudflare.com:3478"] },
            {
              urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
              username: `e2e-${randomBytes(4).toString("hex")}`,
              credential: "e2e-credential",
            },
          ],
        });
        return;
      }
      const app = `/realtime/apps/${FAKE_APP_ID}/sessions`;
      if (!url.startsWith(app)) {
        send(404, { errorCode: "not_found" });
        return;
      }
      if (auth !== `Bearer ${FAKE_APP_SECRET}`) {
        send(401, { errorCode: "unauthorized" });
        return;
      }
      if (url === `${app}/new` && req.method === "POST") {
        send(201, { sessionId: randomBytes(16).toString("hex") });
        return;
      }
      if (/\/tracks\/(new|close)$/.test(url)) {
        const tracks = (body.tracks as Record<string, unknown>[] | undefined) ?? [];
        send(200, {
          requiresImmediateRenegotiation: false,
          sessionDescription: { type: "answer", sdp: "v=0 e2e answer" },
          tracks: tracks.map((t, i) => ({ ...t, mid: t.mid ?? String(i) })),
        });
        return;
      }
      if (url.endsWith("/renegotiate") && req.method === "PUT") {
        send(200, {});
        return;
      }
      send(404, { errorCode: "not_found" });
    });
  });
  await new Promise<void>((resolve) => server?.listen(port, "127.0.0.1", resolve));
  return () =>
    new Promise<void>((resolve) => {
      server?.close(() => {
        resolve();
      });
    });
}
