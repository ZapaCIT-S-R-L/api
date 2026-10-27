-- Membership events for the chat and calls services (src/membership-events.ts). Each change to a family writes its
-- event here in the same D1 transaction; a flush sends unsent rows to the MEMBERSHIP_EVENTS queue in seq order and
-- marks them sent. The daily purge deletes rows sent more than 7 days ago. Ids only: no names, no content.
CREATE TABLE membership_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL CHECK (json_valid(body)),
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE INDEX membership_outbox_unsent ON membership_outbox (seq) WHERE sent_at IS NULL;
CREATE INDEX membership_outbox_sent ON membership_outbox (sent_at);
