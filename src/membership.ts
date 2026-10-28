// Who the caller is in chat terms: the device registered on their session and the conversations they belong to.
// The tables behind this (devices: api #20; families and conversations: api #40, #42, #43) are not on main yet, so
// the default source returns only what exists: no device, no conversations. Without a device no chat token is
// issued (409 device_required). Each of those PRs replaces the default with a source that reads its tables.
import type { Env } from "./env";
import type { Session } from "./sessions";

export interface MembershipSource {
  // The libsignal device id registered on this session, or null.
  device(env: Env, session: Session): Promise<number | null>;
  // The conversation ids the account is a member of.
  conversations(env: Env, accountId: string): Promise<string[]>;
}

const existingData: MembershipSource = {
  device: () => Promise.resolve(null),
  conversations: () => Promise.resolve([]),
};

let source: MembershipSource = existingData;

// Tests seed membership data through this; null restores the default.
export function useMembershipSource(replacement: MembershipSource | null): void {
  source = replacement ?? existingData;
}

export function membership(): MembershipSource {
  return source;
}
