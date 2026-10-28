// Daily purge: call log rows older than CALL_LOG_RETENTION_DAYS (at most a year), and the ids of conversation
// events applied more than 14 days ago (src/conversation-events.ts dedupes by them).
import type { Env } from "./env";
import { limits } from "./limits";

const PROCESSED_EVENTS_DAYS = 14;

export async function purgeCallLog(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - limits(env).retentionDays * 86_400_000).toISOString();
  const { meta } = await env.DB.prepare("DELETE FROM calls WHERE created_at < ?").bind(cutoff).run();
  console.log(JSON.stringify({ msg: "call log purged", deleted: meta.changes }));
}

export async function purgeProcessedEvents(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - PROCESSED_EVENTS_DAYS * 86_400_000).toISOString();
  await env.DB.prepare("DELETE FROM processed_events WHERE processed_at < ?").bind(cutoff).run();
}
