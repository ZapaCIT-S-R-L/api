-- Conversation events from the chat service already applied (src/conversation-events.ts). The queue delivers at
-- least once: a replayed event must not drop a member who was readmitted to the conversation meanwhile. Rows are
-- purged after 14 days (src/purge.ts). Times are UTC ISO 8601 text, as in calls.
CREATE TABLE processed_events (
  id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
) STRICT;

CREATE INDEX processed_events_processed ON processed_events (processed_at);
