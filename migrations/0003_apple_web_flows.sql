-- Sign in with Apple on Android (web flow). One row per flow: the PKCE challenge from the app, then, after
-- Apple's callback, the verified identity and the hash of the API's one-time code. No Apple token is stored.
-- Rows are deleted when the code is exchanged, and by the daily purge once expired.
CREATE TABLE apple_web_flows (
  state_hash TEXT PRIMARY KEY CHECK (length(state_hash) = 64),
  code_challenge TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- Set by the callback, once:
  code_hash TEXT UNIQUE CHECK (code_hash IS NULL OR length(code_hash) = 64),
  code_expires_at TEXT,
  subject TEXT,
  email TEXT,
  nonce_claim TEXT,
  display_name TEXT
) STRICT;

CREATE INDEX apple_web_flows_expires ON apple_web_flows (expires_at);
