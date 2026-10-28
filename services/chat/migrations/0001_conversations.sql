-- The chat service's copy of the family graph (from the account service's membership events) and its
-- conversations. Metadata only: no message content, no names, no group titles.

-- Who is in which family. A kid is in exactly one family; a parent normally in one.
CREATE TABLE family_members (
  family_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('parent', 'kid')),
  PRIMARY KEY (family_id, account_id)
) STRICT;
CREATE INDEX family_members_account ON family_members (account_id);

-- Connected families (family_a < family_b) and the kids each family shared through the connection.
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  family_a TEXT NOT NULL,
  family_b TEXT NOT NULL,
  CHECK (family_a < family_b)
) STRICT;
CREATE INDEX connections_families ON connections (family_a, family_b);
CREATE TABLE shared_kids (
  connection_id TEXT NOT NULL,
  kid_account_id TEXT NOT NULL,
  PRIMARY KEY (connection_id, kid_account_id)
) STRICT;
CREATE INDEX shared_kids_kid ON shared_kids (kid_account_id);

-- Each account's libsignal devices, and where to send content-free wake-ups.
CREATE TABLE devices (
  account_id TEXT NOT NULL,
  device_id INTEGER NOT NULL CHECK (device_id BETWEEN 1 AND 127),
  registration_id INTEGER NOT NULL CHECK (registration_id BETWEEN 1 AND 16383),
  push_provider TEXT CHECK (push_provider IN ('apns', 'fcm')),
  push_token TEXT,
  PRIMARY KEY (account_id, device_id)
) STRICT;

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
  -- direct only: the two requested accounts, sorted, so a second open direct chat isn't created.
  direct_key TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  closed_at INTEGER
) STRICT;
CREATE INDEX conversations_direct ON conversations (direct_key) WHERE direct_key IS NOT NULL;

-- Members are accounts. guardian = 1: added by the server as a parent of a kid in the conversation.
-- deleted_at: the member deleted the conversation for themselves (retention: gone once every member did).
CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('parent', 'kid')),
  guardian INTEGER NOT NULL DEFAULT 0 CHECK (guardian IN (0, 1)),
  joined_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (conversation_id, account_id)
) STRICT;
CREATE INDEX conversation_members_account ON conversation_members (account_id);

-- Membership events already applied (at-least-once delivery). Purged after 14 days.
CREATE TABLE processed_events (
  id TEXT PRIMARY KEY,
  processed_at INTEGER NOT NULL
) STRICT;
