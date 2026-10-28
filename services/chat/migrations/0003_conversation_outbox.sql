-- Conversation events for the calls service (src/conversation-events.ts): a member removed from a conversation, a
-- conversation closed. The event row is written in the same D1 batch as the change; a flush sends unsent rows to the
-- CONVERSATION_EVENTS queue in seq order and marks them sent. Rows sent more than 7 days ago are purged hourly.
-- Ids only: no names, no content.
CREATE TABLE conversation_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL CHECK (json_valid(body)),
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE INDEX conversation_outbox_unsent ON conversation_outbox (seq) WHERE sent_at IS NULL;
CREATE INDEX conversation_outbox_sent ON conversation_outbox (sent_at);
