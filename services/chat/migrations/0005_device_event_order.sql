-- Device events arrive at least once and in any order (api #90): a device.upserted older than the last applied
-- change for that device is ignored. `occurred_at` is the occurredAt (ms) of the event that last wrote the row; rows
-- from before this migration have 0, so any upsert still applies to them.
ALTER TABLE devices ADD COLUMN occurred_at INTEGER NOT NULL DEFAULT 0;

-- Survives a device.removed: `last_seen_at` is the highest occurredAt seen for the device when it was last removed
-- (that removal's, or the removed row's `occurred_at` if newer). An upsert that occurred at or before it would bring
-- a removed device back and is ignored. At most 127 rows per account (device ids 1..127); kept, because an outbox
-- event can be sent late.
CREATE TABLE device_tombstones (
  account_id TEXT NOT NULL,
  device_id INTEGER NOT NULL CHECK (device_id BETWEEN 1 AND 127),
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, device_id)
) STRICT;
