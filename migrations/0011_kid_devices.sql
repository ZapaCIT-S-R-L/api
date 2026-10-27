-- Kid phones in the key directory. An account is a parent or a kid (ids are UUIDs and never collide), so the key
-- directory tables lose their foreign key to parents; triggers remove an account's keys when its parent or kid row
-- goes (as the ON DELETE CASCADE did). Kid sessions are bound to their device like parent sessions.
--
-- Safe with the previous Worker: the same tables and columns, every row copied. The child tables are rebuilt first,
-- so dropping the old devices table cascades into nothing. SQLite renames the foreign keys of the new prekey tables
-- along with devices_new.
PRAGMA defer_foreign_keys = true;

CREATE TABLE devices_new (
  account_id TEXT NOT NULL,
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
INSERT INTO devices_new SELECT account_id, device_id, registration_id, signed_prekey_id, signed_prekey,
  signed_prekey_signature, pq_last_resort_id, pq_last_resort_key, pq_last_resort_signature, push_token, created_at,
  last_seen_at FROM devices;

CREATE TABLE one_time_prekeys_new (
  account_id TEXT NOT NULL,
  device_id INTEGER NOT NULL,
  key_id INTEGER NOT NULL,
  public_key TEXT NOT NULL,
  PRIMARY KEY (account_id, device_id, key_id),
  FOREIGN KEY (account_id, device_id) REFERENCES devices_new (account_id, device_id) ON DELETE CASCADE
) STRICT;
INSERT INTO one_time_prekeys_new SELECT account_id, device_id, key_id, public_key FROM one_time_prekeys;

CREATE TABLE pq_one_time_prekeys_new (
  account_id TEXT NOT NULL,
  device_id INTEGER NOT NULL,
  key_id INTEGER NOT NULL,
  public_key TEXT NOT NULL,
  signature TEXT NOT NULL,
  PRIMARY KEY (account_id, device_id, key_id),
  FOREIGN KEY (account_id, device_id) REFERENCES devices_new (account_id, device_id) ON DELETE CASCADE
) STRICT;
INSERT INTO pq_one_time_prekeys_new SELECT account_id, device_id, key_id, public_key, signature FROM pq_one_time_prekeys;

CREATE TABLE account_identities_new (
  account_id TEXT PRIMARY KEY,
  identity_key TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
INSERT INTO account_identities_new SELECT account_id, identity_key, created_at FROM account_identities;

CREATE TABLE identity_key_changes_new (
  account_id TEXT NOT NULL,
  previous_key TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  endorsement TEXT,
  changed_at TEXT NOT NULL
) STRICT;
INSERT INTO identity_key_changes_new SELECT account_id, previous_key, identity_key, endorsement, changed_at
  FROM identity_key_changes ORDER BY rowid;

DROP TABLE one_time_prekeys;
DROP TABLE pq_one_time_prekeys;
DROP TABLE devices;
DROP TABLE account_identities;
DROP TABLE identity_key_changes;

ALTER TABLE devices_new RENAME TO devices;
ALTER TABLE one_time_prekeys_new RENAME TO one_time_prekeys;
ALTER TABLE pq_one_time_prekeys_new RENAME TO pq_one_time_prekeys;
ALTER TABLE account_identities_new RENAME TO account_identities;
ALTER TABLE identity_key_changes_new RENAME TO identity_key_changes;

CREATE INDEX devices_last_seen ON devices (last_seen_at);
CREATE INDEX identity_key_changes_account ON identity_key_changes (account_id, changed_at);

-- An account's keys go with its parent or kid row (also when a family's deletion cascades to its kids).
CREATE TRIGGER parents_delete_keys AFTER DELETE ON parents BEGIN
  DELETE FROM devices WHERE account_id = OLD.id;
  DELETE FROM account_identities WHERE account_id = OLD.id;
  DELETE FROM identity_key_changes WHERE account_id = OLD.id;
END;

CREATE TRIGGER kids_delete_keys AFTER DELETE ON kids BEGIN
  DELETE FROM devices WHERE account_id = OLD.id;
  DELETE FROM account_identities WHERE account_id = OLD.id;
  DELETE FROM identity_key_changes WHERE account_id = OLD.id;
END;

-- The device registered on a kid session (POST /v1/devices), as sessions.device_id for parents.
ALTER TABLE kid_sessions ADD COLUMN device_id INTEGER;
