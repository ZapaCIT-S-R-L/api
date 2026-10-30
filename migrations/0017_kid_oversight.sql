-- Parent oversight per kid (api #94): 1 = the kid's parents observe its chats (the default), 0 = off.
-- No backfill: every existing kid has it on.
ALTER TABLE kids ADD COLUMN oversight INTEGER NOT NULL DEFAULT 1 CHECK (oversight IN (0, 1));
