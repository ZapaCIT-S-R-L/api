-- Parent oversight per kid (api #73): a kid's parents read the kid's chats as observers (read-only, no calls)
-- unless the family turned it off for that kid. No row = on. Fed by the kid.oversight_changed membership event,
-- which carries the full state, so applying it again is safe.
CREATE TABLE kid_oversight (
  kid_account_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
) STRICT;
