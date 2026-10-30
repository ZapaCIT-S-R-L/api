-- The standard APNs token of an iPhone, for the visible "new message" alert (PUT /v1/devices/{id}/alert-push). Kept
-- apart from push_token, the PushKit VoIP token: APNs refuses alert pushes to a VoIP token. Nullable: a device without
-- it gets no message alert (its phone fetches when the app opens). Additive, so the previous Worker keeps working.
ALTER TABLE devices ADD COLUMN alert_push_token TEXT;
