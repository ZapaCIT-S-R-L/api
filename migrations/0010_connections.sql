-- Connections between two families, and the kids each family shares with the other (per kid, per connection).
-- The other family sees a shared kid's nickname and avatar only. Invitation codes are stored as SHA-256 only.

CREATE TABLE family_connections (
  id TEXT PRIMARY KEY,
  -- The two families, smaller id first, so a pair is stored once.
  family_a TEXT NOT NULL REFERENCES families (id) ON DELETE CASCADE,
  family_b TEXT NOT NULL REFERENCES families (id) ON DELETE CASCADE,
  created_by TEXT REFERENCES parents (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  CHECK (family_a < family_b),
  UNIQUE (family_a, family_b)
) STRICT;

CREATE INDEX family_connections_b ON family_connections (family_b);

CREATE TABLE connection_invitations (
  code_hash TEXT PRIMARY KEY CHECK (length(code_hash) = 64),
  family_id TEXT NOT NULL REFERENCES families (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES parents (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT REFERENCES parents (id) ON DELETE SET NULL
) STRICT;

CREATE INDEX connection_invitations_family ON connection_invitations (family_id);
CREATE INDEX connection_invitations_expires ON connection_invitations (expires_at);

CREATE TABLE connection_shared_kids (
  connection_id TEXT NOT NULL REFERENCES family_connections (id) ON DELETE CASCADE,
  kid_id TEXT NOT NULL REFERENCES kids (id) ON DELETE CASCADE,
  shared_by TEXT REFERENCES parents (id) ON DELETE SET NULL,
  shared_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, kid_id)
) STRICT;

CREATE INDEX connection_shared_kids_kid ON connection_shared_kids (kid_id);
