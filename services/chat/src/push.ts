// Content-free wake-ups for devices without an open stream. A push never carries content, names or ids beyond
// "something is waiting": the app wakes, fetches its envelopes and decrypts them on the phone.
// The real APNs (iOS) and FCM (Android) providers come once Stefan provides their credentials (ios #27, android #25);
// until then pushes are switched off and devices fetch when the app opens.
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

export function pushProvider(_env: Env): PushProvider {
  return override ?? pushDisabled;
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
