-- Oversight changes are ordered by occurredAt (api #99 review): delivery is unordered, so a change older than the one
-- that last wrote the row is ignored. `occurred_at` is that event's occurredAt (ms); rows from before are 0.
ALTER TABLE kid_oversight ADD COLUMN occurred_at INTEGER NOT NULL DEFAULT 0;
