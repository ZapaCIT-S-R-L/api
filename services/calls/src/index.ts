// ZapaKid calls Worker (calls.zapakid.ro). It sets up voice calls on Cloudflare Realtime and relays sealed call keys
// between phones; the audio is encrypted on the phones and no key ever reaches this service.
import { routeCalls } from "./calls";
import { consumeConversationEvents } from "./conversation-events";
import type { Env } from "./env";
import { handleHealth } from "./health";
import { error } from "./http";
import { purgeCallLog } from "./purge";

export { CallRoom } from "./call-room";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") {
        if (request.method !== "GET") return error(405, "method_not_allowed", "Use GET.", { allow: "GET" });
        return await handleHealth(request, env);
      }
      return (await routeCalls(request, env)) ?? error(404, "not_found", "No such endpoint.");
    } catch (e) {
      // Never log request bodies or headers: they carry chat tokens and SDP.
      console.error(JSON.stringify({ msg: "unhandled", path: url.pathname, err: String(e) }));
      return error(500, "server_error", "Something went wrong.");
    }
  },

  // Conversation events from the chat service (wrangler.jsonc queues.consumers): members removed, conversation closed.
  async queue(batch, env): Promise<void> {
    await consumeConversationEvents(batch, env);
  },

  async scheduled(_controller, env): Promise<void> {
    await purgeCallLog(env);
  },
} satisfies ExportedHandler<Env>;
