// Content-free wake-ups for devices without an open stream. A push never carries content, names or ids beyond
// "something is waiting": the app wakes, fetches its envelopes and decrypts them on the phone.
// iOS goes through APNs (src/apns.ts) once the APNS_AUTH_KEY, APNS_KEY_ID and APNS_TEAM_ID secrets are set. Android
// (FCM) is not here yet (android #25); until then, and without the secrets, pushes are switched off and devices fetch
// when the app opens.
import { apnsConfigured, providerFor } from "./apns";
import type { Env } from "./env";

export interface PushTarget {
  accountId: string;
  deviceId: number;
  provider: "apns" | "fcm";
  token: string;
}

export interface PushProvider {
  wake(targets: PushTarget[]): Promise<void>;
}

export const pushDisabled: PushProvider = { wake: () => Promise.resolve() };

let override: PushProvider | null = null;

// Tests swap in a recording provider; null restores the default.
export function usePushProvider(provider: PushProvider | null): void {
  override = provider;
}

export function pushProvider(env: Env): PushProvider {
  if (override) return override;
  return apnsConfigured(env) ? providerFor(env) : pushDisabled;
}

// Push targets for these devices (only those with a push token).
export async function pushTargets(env: Env, devices: { accountId: string; deviceId: number }[]): Promise<PushTarget[]> {
  if (devices.length === 0) return [];
  const rows = await env.DB.prepare(
    `SELECT d.account_id, d.device_id, d.push_provider, d.push_token
     FROM devices d JOIN json_each(?1) j ON d.account_id = json_extract(j.value, '$.accountId')
       AND d.device_id = json_extract(j.value, '$.deviceId')
     WHERE d.push_token IS NOT NULL AND d.push_provider IS NOT NULL`,
  )
    .bind(JSON.stringify(devices))
    .all<{ account_id: string; device_id: number; push_provider: "apns" | "fcm"; push_token: string }>();
  return rows.results.map((r) => ({
    accountId: r.account_id,
    deviceId: r.device_id,
    provider: r.push_provider,
    token: r.push_token,
  }));
}
