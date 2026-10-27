// Ringing the other members' phones: PushKit VoIP (iOS, with CallKit) and high-priority FCM data messages (Android,
// with a full-screen incoming call). Pushes carry no content beyond the call id. The APNs and FCM credentials come
// from Stefan later (ios #27, android #25), and the device push tokens with the device directory, so the provider is
// a stub for now: phones also learn about calls from the events WebSocket and the call log.
export interface RingingCall {
  callId: string;
  conversationId: string;
  // The caller's account id.
  from: string;
}

export interface PushProvider {
  // Rings every member device of the conversation except the caller's.
  ring(call: RingingCall): Promise<void>;
  // Stops the ringing (answered elsewhere, cancelled, no answer).
  cancel(call: RingingCall): Promise<void>;
}

const noPush: PushProvider = {
  ring: () => Promise.resolve(),
  cancel: () => Promise.resolve(),
};

let provider: PushProvider = noPush;

// Tests (and later the APNs/FCM implementation) set the provider; null restores the stub.
export function usePushProvider(replacement: PushProvider | null): void {
  provider = replacement ?? noPush;
}

export function pushProvider(): PushProvider {
  return provider;
}
