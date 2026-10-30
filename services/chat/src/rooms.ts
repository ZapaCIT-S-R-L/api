// What the conversation logic needs from the live side (the conversation Durable Objects): tell connected devices
// that something changed, drop an account's or device's delivery copies, close the streams of revoked tokens, and
// delete everything on purge.
export type RoomEventKind = "members_changed" | "devices_changed" | "conversation_closed";

export interface Rooms {
  // `removed`: accounts whose streams are closed (they left the conversation).
  notify(conversationId: string, kind: RoomEventKind, removed: string[]): Promise<void>;
  forgetAccount(conversationId: string, accountId: string): Promise<void>;
  forgetDevice(conversationId: string, accountId: string, deviceId: number): Promise<void>;
  // Closes the account's streams opened with a chat token whose session epoch is below `epoch` (api #81).
  revokeSessions(conversationId: string, accountId: string, epoch: number): Promise<void>;
  // Tells the account's open events streams (GET /v1/events) that it is now in the conversation.
  conversationAdded(conversationId: string, accountId: string): Promise<void>;
  // Closes the account's events streams opened with a chat token whose session epoch is below `epoch`.
  revokeAccountSessions(accountId: string, epoch: number): Promise<void>;
  // Closes a removed device's events streams (GET /v1/events).
  forgetAccountDevice(accountId: string, deviceId: number): Promise<void>;
  purge(conversationId: string): Promise<void>;
}

// Until the conversation Durable Object exists, nothing is live and nothing is queued.
export const noRooms: Rooms = {
  notify: () => Promise.resolve(),
  forgetAccount: () => Promise.resolve(),
  forgetDevice: () => Promise.resolve(),
  revokeSessions: () => Promise.resolve(),
  conversationAdded: () => Promise.resolve(),
  revokeAccountSessions: () => Promise.resolve(),
  forgetAccountDevice: () => Promise.resolve(),
  purge: () => Promise.resolve(),
};
