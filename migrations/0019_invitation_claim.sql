-- A per-redemption marker on family invitations: the statements that act on a redemption run only when the claim
-- carrying this request's marker is the one that used the code (used_by + used_at can collide in one millisecond).
-- Nullable: the previous Worker neither writes nor reads it.
ALTER TABLE family_invitations ADD COLUMN claim_id TEXT;
