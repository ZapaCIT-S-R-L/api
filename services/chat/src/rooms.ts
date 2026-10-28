// What the conversation logic needs from the live side (the conversation Durable Objects): tell connected devices
// that something changed, drop an account's or device's delivery copies, and delete everything on purge.
export type RoomEventKind = "members_changed" | "devices_changed" | "conversation_closed";

export interface Rooms {
  // `removed`: accounts whose streams are closed (they left the conversation).
  notify(conversationId: string, kind: RoomEventKind, removed: string[]): Promise<void>;
  forgetAccount(conversationId: string, accountId: string): Promise<void>;
  forgetDevice(conversationId: string, accountId: string, deviceId: number): Promise<void>;
  purge(conversationId: string): Promise<void>;
}

// Until the conversation Durable Object exists, nothing is live and nothing is queued.
export const noRooms: Rooms = {
  notify: () => Promise.resolve(),
  forgetAccount: () => Promise.resolve(),
  forgetDevice: () => Promise.resolve(),
  purge: () => Promise.resolve(),
};
