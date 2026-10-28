-- Session epochs from the account service (account.sessions_revoked, api #81): the highest epoch seen per account.
-- A chat token whose `sep` claim is below it was issued before the account signed out everywhere and is refused.
CREATE TABLE session_epochs (
  account_id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL CHECK (epoch >= 1)
) STRICT;
