-- Where a device's wake-up pushes go: the provider next to the token (PUT /v1/devices/{id}/push). Both are nullable:
-- a device without a push target isn't woken (its phone fetches when the app opens). Additive, so the previous
-- Worker version, which doesn't write it, keeps working.
ALTER TABLE devices ADD COLUMN push_provider TEXT;
