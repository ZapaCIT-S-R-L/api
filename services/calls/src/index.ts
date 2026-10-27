// ZapaKid calls Worker (calls.zapakid.ro). It sets up voice calls on Cloudflare Realtime and relays sealed call keys
// between phones; the audio is encrypted on the phones and no key ever reaches this service.
import type { Env } from "./env";
import { handleHealth } from "./health";
import { error } from "./http";

type Handler = (request: Request, env: Env) => Response | Promise<Response>;

const ROUTES: Record<string, { method: string; handler: Handler }> = {
  "/health": { method: "GET", handler: handleHealth },
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : undefined;
      if (!route) return error(404, "not_found", "No such endpoint.");
      if (request.method !== route.method) {
        return error(405, "method_not_allowed", `Use ${route.method}.`, { allow: route.method });
      }
      return await route.handler(request, env);
    } catch (e) {
      // Never log request bodies or headers: they carry chat tokens and SDP.
      console.error(JSON.stringify({ msg: "unhandled", path: url.pathname, err: String(e) }));
      return error(500, "server_error", "Something went wrong.");
    }
  },
} satisfies ExportedHandler<Env>;
