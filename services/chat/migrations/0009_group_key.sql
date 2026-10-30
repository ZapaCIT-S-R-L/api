-- Group chats: the sorted member ids the group was started with (caller plus requested members), so starting the same
-- group again returns the open one instead of a duplicate. Mirrors direct_key (0001). Groups started before this
-- migration have no key and aren't matched.
ALTER TABLE conversations ADD COLUMN group_key TEXT;
CREATE INDEX conversations_group ON conversations (group_key) WHERE group_key IS NOT NULL;
