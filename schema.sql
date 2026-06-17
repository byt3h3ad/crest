CREATE TABLE IF NOT EXISTS stories (
  id           INTEGER PRIMARY KEY,   -- HN item id (Algolia objectID)
  title        TEXT    NOT NULL,
  url          TEXT,                  -- NULL for text posts (Ask HN, etc.)
  points       INTEGER NOT NULL,      -- score at the moment we first saw it
  num_comments INTEGER NOT NULL DEFAULT 0,
  author       TEXT,
  hn_created   INTEGER NOT NULL,      -- created_at_i: when posted to HN (unix sec)
  first_seen   INTEGER NOT NULL       -- when it entered our feed (unix sec)
);

CREATE INDEX IF NOT EXISTS idx_stories_first_seen ON stories (first_seen DESC);

-- Single-row-per-key store for poller heartbeat (k='last_poll').
CREATE TABLE IF NOT EXISTS meta (
  k TEXT    PRIMARY KEY,
  v INTEGER NOT NULL
);
