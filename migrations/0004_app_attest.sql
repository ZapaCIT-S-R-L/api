-- Apple App Attest (iOS). Challenges for key registration (SHA-256 only, single use, 5 minutes), and the
-- registered keys: the public key (uncompressed P-256 point, base64) and the last assertion counter. A key is a
-- device's app install, not a person: nothing here identifies the user.
CREATE TABLE app_attest_challenges (
  challenge_hash TEXT PRIMARY KEY CHECK (length(challenge_hash) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX app_attest_challenges_expires ON app_attest_challenges (expires_at);

CREATE TABLE app_attest_keys (
  key_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL CHECK (counter >= 0),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  created_at TEXT NOT NULL,
  last_used_at TEXT
) STRICT;
