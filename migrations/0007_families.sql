-- Families: parents (adults) and the kids they add. A kid has only a nickname, an avatar and a school grade: no
-- real name, birthday or photo. Times are UTC ISO 8601 text. Invitation codes are stored as SHA-256 only.

CREATE TABLE families (
  id TEXT PRIMARY KEY,
  name TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 60),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE family_parents (
  family_id TEXT NOT NULL REFERENCES families (id) ON DELETE CASCADE,
  parent_id TEXT NOT NULL REFERENCES parents (id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (family_id, parent_id)
) STRICT;

-- v1: a parent belongs to one family. Dropping this index later allows more.
CREATE UNIQUE INDEX family_parents_one_family ON family_parents (parent_id);

-- grade: -1 kindergarten, 0 preparatory class, 1-12 school grades, NULL not set.
CREATE TABLE kids (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families (id) ON DELETE CASCADE,
  nickname TEXT NOT NULL CHECK (length(nickname) BETWEEN 1 AND 40),
  avatar TEXT NOT NULL CHECK (length(avatar) BETWEEN 1 AND 32),
  grade INTEGER CHECK (grade IS NULL OR grade BETWEEN -1 AND 12),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX kids_family ON kids (family_id);

-- One-time codes that let another parent join (QR or link). Deleted by the daily purge once expired.
CREATE TABLE family_invitations (
  code_hash TEXT PRIMARY KEY CHECK (length(code_hash) = 64),
  family_id TEXT NOT NULL REFERENCES families (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES parents (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT REFERENCES parents (id) ON DELETE SET NULL
) STRICT;

CREATE INDEX family_invitations_family ON family_invitations (family_id);
CREATE INDEX family_invitations_expires ON family_invitations (expires_at);
