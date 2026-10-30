-- The iPhone's standard APNs token for the message alert (the account service's devices.alert_push_token, carried by
-- device.upserted as alertPush). Nullable: no token, no alert. Additive, so the previous Worker keeps working.
ALTER TABLE devices ADD COLUMN alert_push_token TEXT;
