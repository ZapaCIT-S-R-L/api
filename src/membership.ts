// Who the caller is in chat terms: the device registered on their session and the conversation scopes they belong
// to (family-membership.ts: their family, and the connections they are in). Without a device no chat token is
// issued (409 device_required).
import type { Account } from "./accounts";
import type { Env } from "./env";
import { conversationScopes } from "./family-membership";

export interface MembershipSource {
  // The libsignal device id registered on this session, or null.
  device(env: Env, account: Account): Promise<number | null>;
  // The conversation scopes the account is a member of.
  conversations(env: Env, accountId: string): Promise<string[]>;
}

const existingData: MembershipSource = {
  device: (_env, account) => Promise.resolve(account.deviceId),
  conversations: conversationScopes,
};

let source: MembershipSource = existingData;

// Tests seed membership data through this; null restores the default.
export function useMembershipSource(replacement: MembershipSource | null): void {
  source = replacement ?? existingData;
}

export function membership(): MembershipSource {
  return source;
}
