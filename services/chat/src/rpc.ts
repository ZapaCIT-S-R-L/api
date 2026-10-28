// ChatMembership: Workers RPC for other ZapaKid Workers, reached only through a service binding (the calls service's
// CHAT binding), never over public HTTP. The calls service asks whether the caller is a current member of a
// conversation before a call is started, joined or shown, and which members and devices to ring.
//
// "Current member" here is the same rule as the chat API's: a row in conversation_members that the account hasn't
// deleted, in a conversation that is still open (a closed conversation is read-only, so no calls either). Members
// who deleted the conversation are neither callers nor rung. Only ids leave this service: no names, no keys.
// When api #73 lands, observers will be excluded from calls; for now every member is included.
import { WorkerEntrypoint } from "cloudflare:workers";
import { ACCOUNT_ID, CONVERSATION_ID } from "./body";
import { devicesOf, membersOf } from "./conversations";
import type { Env } from "./env";
import type { Role } from "./graph";

export interface CallMember {
  accountId: string;
  role: Role;
  // libsignal device ids (1-127), ascending.
  devices: number[];
}

export interface Membership {
  member: boolean;
  // Every current member, the asking account included; empty unless `member` is true.
  members: CallMember[];
}

const NOT_A_MEMBER: Membership = { member: false, members: [] };

// null: no such conversation (or not a conversation id).
export async function membership(env: Env, conversationId: unknown, accountId: unknown): Promise<Membership | null> {
  if (typeof conversationId !== "string" || !CONVERSATION_ID.test(conversationId)) return null;
  const conversation = await env.DB.prepare("SELECT state FROM conversations WHERE id = ?1")
    .bind(conversationId)
    .first<{ state: "open" | "closed" }>();
  if (!conversation) return null;
  if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId) || conversation.state !== "open") {
    return NOT_A_MEMBER;
  }
  const current = (await membersOf(env, conversationId)).filter((m) => m.deleted_at === null);
  if (!current.some((m) => m.account_id === accountId)) return NOT_A_MEMBER;
  const devices = await devicesOf(
    env,
    current.map((m) => m.account_id),
  );
  return {
    member: true,
    members: current.map((m) => ({
      accountId: m.account_id,
      role: m.role,
      devices: (devices.get(m.account_id) ?? []).map((d) => d.deviceId),
    })),
  };
}

export class ChatMembership extends WorkerEntrypoint<Env> {
  async member(conversationId: string, accountId: string): Promise<Membership | null> {
    return membership(this.env, conversationId, accountId);
  }
}
