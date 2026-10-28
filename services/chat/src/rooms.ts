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
  purge(conversationId: string): Promise<void>;
}

// Until the conversation Durable Object exists, nothing is live and nothing is queued.
export const noRooms: Rooms = {
  notify: () => Promise.resolve(),
  forgetAccount: () => Promise.resolve(),
  forgetDevice: () => Promise.resolve(),
  revokeSessions: () => Promise.resolve(),
  purge: () => Promise.resolve(),
};
