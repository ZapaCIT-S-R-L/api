-- The iPhone's standard APNs token for the message alert (the account service's devices.alert_push_token, carried by
-- device.upserted as alertPush). Nullable: no token, no alert.
ALTER TABLE devices ADD COLUMN alert_push_token TEXT;

-- The two push targets change in separate events, so each is ordered on its own (occurredAt, in ms): an older change to
-- one target must not lose to a newer change to the other. occurred_at stays the row's newest event (registration id,
-- tombstones). Existing targets get the row's time, so an older event still can't overwrite them.
-- Additive with defaults, so the previous Worker keeps working.
ALTER TABLE devices ADD COLUMN push_occurred_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN alert_occurred_at INTEGER NOT NULL DEFAULT 0;
UPDATE devices SET push_occurred_at = occurred_at, alert_occurred_at = occurred_at;
