-- Encrypted attachments (photos, voice messages) in R2 under the attachment id. The key and digest travel inside the
-- encrypted message; the server knows only the conversation, the size and the times.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  uploader_account TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  -- reserved: waiting for its one-time upload; uploading: the upload URL was used; uploaded: in R2.
  state TEXT NOT NULL CHECK (state IN ('reserved', 'uploading', 'uploaded')),
  -- SHA-256 (hex) of the one-time upload token; NULL once used.
  upload_token_hash TEXT,
  upload_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  uploaded_at INTEGER
) STRICT;
CREATE INDEX attachments_conversation ON attachments (conversation_id);
CREATE INDEX attachments_state ON attachments (state, created_at);

-- One-time download tokens (SHA-256 hex), 15 minutes.
CREATE TABLE attachment_downloads (
  token_hash TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX attachment_downloads_expiry ON attachment_downloads (expires_at);
