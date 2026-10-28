// Daily purge of the call log: rows older than CALL_LOG_RETENTION_DAYS (at most a year) are deleted.
import type { Env } from "./env";
import { limits } from "./limits";

export async function purgeCallLog(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - limits(env).retentionDays * 86_400_000).toISOString();
  const { meta } = await env.DB.prepare("DELETE FROM calls WHERE created_at < ?").bind(cutoff).run();
  console.log(JSON.stringify({ msg: "call log purged", deleted: meta.changes }));
}
