-- The account identity key's history (PUT /v1/keys/identity), so a change is never silent: peers see the previous
-- and new key, and the old key's endorsement (libsignal signAlternateIdentity) when the phone still had it. The
-- server stores the endorsement as is; peers verify it.
CREATE TABLE identity_key_changes (
  account_id TEXT NOT NULL REFERENCES parents (id) ON DELETE CASCADE,
  previous_key TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  endorsement TEXT,
  changed_at TEXT NOT NULL
) STRICT;

CREATE INDEX identity_key_changes_account ON identity_key_changes (account_id, changed_at);
