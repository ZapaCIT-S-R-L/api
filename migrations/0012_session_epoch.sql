-- Session epoch per parent (api #81): POST /v1/auth/logout-all increments it. Chat tokens carry it (`sep` claim)
-- and the chat and calls services refuse tokens from before the current epoch, so a lost phone loses chat and
-- calls at once, not when its last chat token expires. The previous Worker version ignores the column.
ALTER TABLE parents ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;
