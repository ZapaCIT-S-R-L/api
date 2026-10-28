-- The key directory (libsignal): one identity key per account, and per device its registration id, signed EC
-- prekey, signed Kyber last-resort prekey, and one-time EC and Kyber prekeys. Public keys and signatures only, as
-- base64. Accounts are parents for now (kids come with families). A session is bound to the device registered on it.
CREATE TABLE account_identities (
  account_id TEXT PRIMARY KEY REFERENCES parents (id) ON DELETE CASCADE,
  identity_key TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE devices (
  account_id TEXT NOT NULL REFERENCES parents (id) ON DELETE CASCADE,
  device_id INTEGER NOT NULL CHECK (device_id BETWEEN 1 AND 127),
  registration_id INTEGER NOT NULL CHECK (registration_id BETWEEN 1 AND 16383),
  signed_prekey_id INTEGER NOT NULL,
  signed_prekey TEXT NOT NULL,
  signed_prekey_signature TEXT NOT NULL,
  pq_last_resort_id INTEGER NOT NULL,
  pq_last_resort_key TEXT NOT NULL,
  pq_last_resort_signature TEXT NOT NULL,
  push_token TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (account_id, device_id)
) STRICT;

CREATE INDEX devices_last_seen ON devices (last_seen_at);

CREATE TABLE one_time_prekeys (
  account_id TEXT NOT NULL,
  device_id INTEGER NOT NULL,
  key_id INTEGER NOT NULL,
  public_key TEXT NOT NULL,
  PRIMARY KEY (account_id, device_id, key_id),
  FOREIGN KEY (account_id, device_id) REFERENCES devices (account_id, device_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE pq_one_time_prekeys (
  account_id TEXT NOT NULL,
  device_id INTEGER NOT NULL,
  key_id INTEGER NOT NULL,
  public_key TEXT NOT NULL,
  signature TEXT NOT NULL,
  PRIMARY KEY (account_id, device_id, key_id),
  FOREIGN KEY (account_id, device_id) REFERENCES devices (account_id, device_id) ON DELETE CASCADE
) STRICT;

ALTER TABLE sessions ADD COLUMN device_id INTEGER;
