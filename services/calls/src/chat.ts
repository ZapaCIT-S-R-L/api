// Conversation membership from the chat service, the only service that knows conversations and their members. The
// CHAT service binding (wrangler.jsonc) reaches its ChatMembership entrypoint (services/chat/src/rpc.ts) over Workers
// RPC, never public HTTP. Asked on every start, join and view of a call, so a member removed from the conversation
// loses access to its calls at once; nothing is cached.
import type { Role } from "./auth";
import type { Env } from "./env";
import type { RingTarget } from "./push";

export interface ChatMember {
  accountId: string;
  role: Role;
  // libsignal device ids (1-127).
  devices: number[];
  // The devices with a push target (iOS: the PushKit VoIP token). Missing from an older chat Worker: no pushes.
  push?: PushTarget[];
}

export interface PushTarget {
  deviceId: number;
  provider: "apns" | "fcm";
  token: string;
}

export interface Membership {
  member: boolean;
  // The account reads the conversation as a kid's parent (api #73): it may see the call log, but it can't start,
  // join or be rung for a call, and it never gets the call key.
  observer: boolean;
  // Every current member of the conversation who takes part in calls, the asking account included; empty unless
  // `member`. Observers are never listed.
  members: ChatMember[];
}

// The chat service's ChatMembership entrypoint, as the binding exposes it. null: no such conversation.
export interface ChatMembershipRpc {
  member(conversationId: string, accountId: string): Promise<Membership | null>;
  // Whether a chat token for the account's device, issued at `iat` (seconds) at session epoch `sep`, was revoked: by
  // a logout-all (api #81) or because the device was removed since (api #92).
  tokenRevoked(accountId: string, deviceId: number, sep: number, iat: number): Promise<boolean>;
}

// The chat service failed or answered something unexpected: refuse (503), never allow.
export class ChatUnavailable extends Error {}

// The chat Worker behind the CHAT binding predates an RPC method calls needs (it was deployed after calls, against
// the order in deploy-calls.yml). Refused like an outage, but retryable: answered 503 with Retry-After until the
// newer chat Worker is live. Never treated as "not revoked".
export class ChatOutdated extends ChatUnavailable {}

// How workerd rejects a call to a method the RPC receiver doesn't have (TypeError: The RPC receiver does not
// implement the method "tokenRevoked".).
const MISSING_METHOD = /does not implement the method/;

const NOT_A_MEMBER: Membership = { member: false, observer: false, members: [] };
const OBSERVER: Membership = { member: false, observer: true, members: [] };

const isDevice = (d: unknown): d is number => typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 127;

const isPushTarget = (p: unknown): p is PushTarget => {
  if (typeof p !== "object" || p === null) return false;
  const v = p as Record<string, unknown>;
  return (
    isDevice(v.deviceId) &&
    (v.provider === "apns" || v.provider === "fcm") &&
    typeof v.token === "string" &&
    v.token.length > 0
  );
};

function isMember(m: unknown): m is ChatMember {
  if (typeof m !== "object" || m === null) return false;
  const v = m as Record<string, unknown>;
  return (
    typeof v.accountId === "string" &&
    v.accountId.length > 0 &&
    (v.role === "parent" || v.role === "kid") &&
    Array.isArray(v.devices) &&
    v.devices.every(isDevice) &&
    (v.push === undefined || (Array.isArray(v.push) && v.push.every(isPushTarget)))
  );
}

export async function membership(env: Env, conversationId: string, accountId: string): Promise<Membership> {
  let answer: unknown;
  try {
    answer = await env.CHAT.member(conversationId, accountId);
  } catch (e) {
    throw new ChatUnavailable(String(e));
  }
  if (answer === null) return NOT_A_MEMBER;
  const a = answer as Partial<Membership> | undefined;
  if (typeof a?.member !== "boolean" || !Array.isArray(a.members) || !a.members.every(isMember)) {
    throw new ChatUnavailable("unexpected answer from ChatMembership.member");
  }
  if (!a.member) return a.observer === true ? OBSERVER : NOT_A_MEMBER;
  // A member must be on the list it gets back; anything else is a broken answer.
  if (!a.members.some((m) => m.accountId === accountId)) {
    throw new ChatUnavailable("ChatMembership.member left the member out");
  }
  return {
    member: true,
    observer: false,
    members: a.members.map((m) => ({
      accountId: m.accountId,
      role: m.role,
      devices: [...m.devices],
      push: (m.push ?? []).map((p) => ({ deviceId: p.deviceId, provider: p.provider, token: p.token })),
    })),
  };
}

// The token a participant or socket holds, as far as the revocation check needs it.
export interface TokenRef {
  accountId: string;
  deviceId: number;
  sep: number;
  iat: number;
}

// Whether the caller's chat token was revoked: the account signed out everywhere (POST /v1/auth/logout-all at the
// account API, api #81), or the device was removed after the token was issued (a kid's phone revoked or signed out,
// api #92). Only the chat service receives those events, so it is asked on every request and before every relayed
// key; a token found revoked is refused like an invalid one.
export async function revoked(env: Env, who: TokenRef): Promise<boolean> {
  let answer: unknown;
  try {
    answer = await env.CHAT.tokenRevoked(who.accountId, who.deviceId, who.sep, who.iat);
  } catch (e) {
    if (e instanceof TypeError && MISSING_METHOD.test(e.message)) {
      throw new ChatOutdated("the chat Worker has no ChatMembership.tokenRevoked (deploy chat before calls)");
    }
    throw new ChatUnavailable(String(e));
  }
  if (typeof answer !== "boolean") throw new ChatUnavailable("unexpected answer from ChatMembership.tokenRevoked");
  return answer;
}

// The devices to ring for a call: every device of every other member (not the caller's own devices), each with its
// push target when it has one.
export function ringTargets(members: ChatMember[], callerAccountId: string): RingTarget[] {
  return members
    .filter((m) => m.accountId !== callerAccountId)
    .flatMap((m) =>
      m.devices.map((deviceId): RingTarget => {
        const target = (m.push ?? []).find((p) => p.deviceId === deviceId);
        return target
          ? { accountId: m.accountId, deviceId, push: { provider: target.provider, token: target.token } }
          : { accountId: m.accountId, deviceId };
      }),
    );
}
