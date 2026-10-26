// The rate limit key for a client address: IPv4 as is, IPv6 by its /64 network.
import { describe, expect, it } from "vitest";
import { clientKey } from "../../src/rate-limit";

describe("clientKey", () => {
  const cases: [string | null, string][] = [
    ["203.0.113.5", "ip4:203.0.113.5"],
    ["2001:db8:1:2::1", "ip6:2001:db8:1:2"],
    ["2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd", "ip6:2001:db8:1:2"],
    ["2001:DB8:1:2:0:0:0:1", "ip6:2001:db8:1:2"],
    ["::1", "ip6:0:0:0:0"],
    ["2001:db8::", "ip6:2001:db8:0:0"],
    ["::ffff:203.0.113.5", "ip4:203.0.113.5"],
    [null, "unknown"],
    ["not an ip", "unknown"],
  ];
  for (const [ip, key] of cases) {
    it(`${String(ip)} → ${key}`, () => {
      expect(clientKey(ip)).toBe(key);
    });
  }
});
