-- Kid sessions become listable and revocable one by one (api #78): a parent lists a kid's paired phones
-- (GET /v1/families/{familyId}/kids/{kidId}/sessions) and revokes a lost or replaced one. `id` names a session
-- without exposing the token hash; `last_seen_at` (day-granular) tells the phones apart. Both are nullable so the
-- previous Worker version, which inserts neither, keeps working: such rows get an id when a parent first lists them,
-- and last_seen_at falls back to created_at.
ALTER TABLE kid_sessions ADD COLUMN id TEXT;
ALTER TABLE kid_sessions ADD COLUMN last_seen_at TEXT;
UPDATE kid_sessions SET id = lower(hex(randomblob(16))) WHERE id IS NULL;
CREATE UNIQUE INDEX kid_sessions_id ON kid_sessions (id);
