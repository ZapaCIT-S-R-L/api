-- Family members: an invitation can replace a parent's phone (joined by that parent only), and a kid's pairing can
-- replace the kid's other phones when the new one pairs.
ALTER TABLE family_invitations ADD COLUMN replaces_account_id TEXT REFERENCES parents (id) ON DELETE CASCADE;
ALTER TABLE kid_pairings ADD COLUMN replaces_phones INTEGER NOT NULL DEFAULT 0 CHECK (replaces_phones IN (0, 1));
