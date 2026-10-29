// Who gets rung for a call: every device of every other member, with its push target when the chat service has one.
import { describe, expect, it } from "vitest";
import { ringTargets, type ChatMember } from "../../src/chat";

const alex: ChatMember = {
  accountId: "alex",
  role: "kid",
  devices: [1, 3],
  push: [{ deviceId: 3, provider: "apns", token: "ab12" }],
};
const mum: ChatMember = { accountId: "mum", role: "parent", devices: [1], push: [] };
const me: ChatMember = { accountId: "me", role: "parent", devices: [1, 2], push: [{ deviceId: 1, provider: "apns", token: "zz" }] };

describe("ringTargets", () => {
  it("rings every other member's device; a device with a push target carries it", () => {
    expect(ringTargets([alex, mum, me], "me")).toEqual([
      { accountId: "alex", deviceId: 1 },
      { accountId: "alex", deviceId: 3, push: { provider: "apns", token: "ab12" } },
      { accountId: "mum", deviceId: 1 },
    ]);
  });

  it("a member from an older chat Worker (no push list) is still rung, without pushes", () => {
    const old = { accountId: "old", role: "parent", devices: [1] } as ChatMember;
    expect(ringTargets([old], "me")).toEqual([{ accountId: "old", deviceId: 1 }]);
  });
});
