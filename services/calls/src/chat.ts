// Conversation membership from the chat service, the only service that knows conversations and their members. The
// CHAT service binding (wrangler.jsonc) reaches its ChatMembership entrypoint (services/chat/src/rpc.ts) over Workers
// RPC, never public HTTP. Asked on every start, join and view of a call, so a member removed from the conversation
// loses access to its calls at once; nothing is cached.
import type { Role } from "./auth";
import type { Env } from "./env";

export interface ChatMember {
  accountId: string;
  role: Role;
  // libsignal device ids (1-127).
  devices: number[];
}

export interface Membership {
  member: boolean;
  // Every current member of the conversation, the asking account included; empty unless `member`.
  members: ChatMember[];
}

// The chat service's ChatMembership entrypoint, as the binding exposes it. null: no such conversation.
export interface ChatMembershipRpc {
  member(conversationId: string, accountId: string): Promise<Membership | null>;
  // Whether a chat token issued at session epoch `sep` for the account was revoked by a logout-all (api #81).
  revoked(accountId: string, sep: number): Promise<boolean>;
}

// The chat service failed or answered something unexpected: refuse (503), never allow.
export class ChatUnavailable extends Error {}

const NOT_A_MEMBER: Membership = { member: false, members: [] };

const isDevice = (d: unknown): d is number => typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 127;

function isMember(m: unknown): m is ChatMember {
  if (typeof m !== "object" || m === null) return false;
  const v = m as Record<string, unknown>;
  return (
    typeof v.accountId === "string" &&
    v.accountId.length > 0 &&
    (v.role === "parent" || v.role === "kid") &&
    Array.isArray(v.devices) &&
    v.devices.every(isDevice)
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
  if (!a.member) return NOT_A_MEMBER;
  // A member must be on the list it gets back; anything else is a broken answer.
  if (!a.members.some((m) => m.accountId === accountId)) {
    throw new ChatUnavailable("ChatMembership.member left the member out");
  }
  return {
    member: true,
    members: a.members.map((m) => ({ accountId: m.accountId, role: m.role, devices: [...m.devices] })),
  };
}

// Whether the caller's chat token was revoked: the account signed out everywhere (POST /v1/auth/logout-all at the
// account API) after the token was issued. Only the chat service receives that event, so it is asked on every
// request and before every relayed key; a token found revoked is refused like an invalid one.
export async function revoked(env: Env, who: { accountId: string; sep: number }): Promise<boolean> {
  let answer: unknown;
  try {
    answer = await env.CHAT.revoked(who.accountId, who.sep);
  } catch (e) {
    throw new ChatUnavailable(String(e));
  }
  if (typeof answer !== "boolean") throw new ChatUnavailable("unexpected answer from ChatMembership.revoked");
  return answer;
}

// The devices to ring for a call: every device of every other member (not the caller's own devices).
export function ringTargets(members: ChatMember[], callerAccountId: string): { accountId: string; deviceId: number }[] {
  return members
    .filter((m) => m.accountId !== callerAccountId)
    .flatMap((m) => m.devices.map((deviceId) => ({ accountId: m.accountId, deviceId })));
}
