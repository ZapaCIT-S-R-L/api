-- One-time sign-in nonces (POST /v1/auth/nonce). The token carries SHA-256(nonce); this table keeps only
-- SHA-256 of that, so neither the nonce nor the token's claim is stored. A row is deleted when used.
CREATE TABLE sign_in_nonces (
  nonce_hash TEXT PRIMARY KEY CHECK (length(nonce_hash) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX sign_in_nonces_expires ON sign_in_nonces (expires_at);
