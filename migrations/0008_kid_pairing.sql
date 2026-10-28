-- Kid pairing by QR: one-time codes (SHA-256 only, 5 minutes) and kid sessions (SHA-256 of the token only). Kids
-- never sign in with Apple or Google: a parent's code is the only way a kid's phone gets a session.

CREATE TABLE kid_pairings (
  code_hash TEXT PRIMARY KEY CHECK (length(code_hash) = 64),
  kid_id TEXT NOT NULL REFERENCES kids (id) ON DELETE CASCADE,
  family_id TEXT NOT NULL REFERENCES families (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES parents (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  -- The session the code was redeemed for (its hash), so the session insert runs only for the redeeming request.
  session_hash TEXT
) STRICT;

CREATE INDEX kid_pairings_family ON kid_pairings (family_id);
CREATE INDEX kid_pairings_expires ON kid_pairings (expires_at);

CREATE TABLE kid_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  kid_id TEXT NOT NULL REFERENCES kids (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX kid_sessions_kid ON kid_sessions (kid_id);
CREATE INDEX kid_sessions_expires ON kid_sessions (expires_at);
