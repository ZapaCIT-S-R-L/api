-- The call log: metadata only (who started a call in which conversation, when, how it ended). Audio is never
-- stored. Times are UTC ISO 8601 text. Retention: README.md.
CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  created_by_account TEXT NOT NULL,
  created_by_device INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  ended_at TEXT,
  end_reason TEXT CHECK (end_reason IN ('hung_up', 'no_answer', 'declined', 'max_duration', 'disconnected')),
  peak_participants INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE INDEX calls_conversation ON calls (conversation_id, created_at);
CREATE INDEX calls_created ON calls (created_at);
