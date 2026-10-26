-- Parents (adults who signed in with Apple or Google), their sign-in identities, and sessions.
-- Times are UTC ISO 8601 text. Sessions store only the SHA-256 of the token, never the token.

CREATE TABLE parents (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  age_category TEXT NOT NULL CHECK (age_category IN ('adult', 'unknown')),
  age_source TEXT NOT NULL CHECK (age_source IN ('apple_declared_age_range', 'google_play_age_signals')),
  age_lower INTEGER,
  age_upper INTEGER,
  age_platform_status TEXT,
  age_checked_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- One row per Apple or Google account. Accounts are never linked by email: the same email on Apple and Google is
-- two parents until a parent links them explicitly (later).
CREATE TABLE parent_identities (
  provider TEXT NOT NULL CHECK (provider IN ('apple', 'google')),
  subject TEXT NOT NULL,
  parent_id TEXT NOT NULL REFERENCES parents (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_sign_in_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
) STRICT;

CREATE INDEX parent_identities_parent ON parent_identities (parent_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  parent_id TEXT NOT NULL REFERENCES parents (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX sessions_parent ON sessions (parent_id);
CREATE INDEX sessions_expires ON sessions (expires_at);
