// ZapaKid API Worker. The server only ever sees public keys and ciphertext; it can never decrypt a chat.
import type { Env } from "./env";
import { error, json } from "./http";

export default {
  fetch(request, env): Response {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") {
        if (request.method !== "GET") return error(405, "method_not_allowed", "Use GET.", { allow: "GET" });
        return json({ status: "ok", version: env.VERSION });
      }
      return error(404, "not_found", "No such endpoint.");
    } catch (e) {
      console.error(JSON.stringify({ msg: "unhandled", path: url.pathname, err: String(e) }));
      return error(500, "server_error", "Something went wrong.");
    }
  },
} satisfies ExportedHandler<Env>;
