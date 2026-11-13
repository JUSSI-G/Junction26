-- Rewritten: tables for "how Finnish Wikipedia told its history". Created by create_tables.py.
-- Everything time-related lives in SYSTEM-VERSIONED tables and is queried with FOR SYSTEM_TIME.

-- 1. Article text history. One row per article = what Wikipedia shows today; MariaDB keeps
--    every earlier version as a history row. load_parquet.py writes those with Wikipedia's real
--    edit times (system_versioning_insert_history), so AS OF '2010-01-01' = Wikipedia on that day.
--    Copied from the reference schema, plus parent_id and anonymous from dataset M.
--    No PARTITION BY SYSTEM_TIME: the reference measured no speed-up and 25% more disk.
CREATE TABLE IF NOT EXISTS article (
  page_id     INT UNSIGNED NOT NULL,          -- Wikipedia's own id
  title       VARCHAR(255) NOT NULL,          -- can change over time: pages get renamed
  rev_id      INT UNSIGNED NOT NULL,          -- Wikipedia's id of this version
  parent_id   INT UNSIGNED,                   -- the version this one was edited from
  user        VARCHAR(255),                   -- user name or IP address
  anonymous   BOOL NOT NULL DEFAULT 0,
  comment     TEXT,                           -- the edit summary
  minor       BOOL NOT NULL DEFAULT 0,
  sha1        CHAR(31),                       -- same hash = same text: how reverts are found
  len         INT UNSIGNED,                   -- length of the text in bytes
  text        MEDIUMTEXT COMPRESSED NOT NULL, -- wikitext, compressed value by value
  row_start   TIMESTAMP(6) GENERATED ALWAYS AS ROW START INVISIBLE,
  row_end     TIMESTAMP(6) GENERATED ALWAYS AS ROW END INVISIBLE,
  PERIOD FOR SYSTEM_TIME (row_start, row_end),
  PRIMARY KEY (page_id),
  KEY (sha1),
  -- MariaDB's own history index is ordered by row_end; this one makes "as of an old date" fast.
  KEY start_key (page_id, row_start)
) CHARACTER SET utf8mb4
  WITH SYSTEM VERSIONING;

-- The articles loaded, with why they were chosen.
CREATE TABLE IF NOT EXISTS article_list (
  page_id  INT UNSIGNED NOT NULL PRIMARY KEY,
  title    VARCHAR(255) NOT NULL,
  why      VARCHAR(255)
) CHARACTER SET utf8mb4;

-- 2. Places: every link target that has coordinates (from Wikidata P625).
CREATE TABLE IF NOT EXISTS place (
  title  VARCHAR(255) PRIMARY KEY,
  qid    VARCHAR(20),
  lat    DOUBLE,
  lon    DOUBLE,
  kind   VARCHAR(50)
) CHARACTER SET utf8mb4;

-- 3. The article's own location: its own P625, else its event location (P276 -> P625).
CREATE TABLE IF NOT EXISTS page_place (
  page_id     INT UNSIGNED PRIMARY KEY,
  place_title VARCHAR(255)
) CHARACTER SET utf8mb4;

-- 4. Place links over time, one row per (page, linked place). A row lives from the first
--    version containing the link to the first version without it; a link that comes back
--    later is a new history row.
CREATE TABLE IF NOT EXISTS place_link (
  page_id     INT UNSIGNED NOT NULL,
  to_place    VARCHAR(255) NOT NULL,
  mentions    SMALLINT UNSIGNED NOT NULL,     -- times linked in that version
  row_start   TIMESTAMP(6) GENERATED ALWAYS AS ROW START INVISIBLE,
  row_end     TIMESTAMP(6) GENERATED ALWAYS AS ROW END INVISIBLE,
  PERIOD FOR SYSTEM_TIME (row_start, row_end),
  PRIMARY KEY (page_id, to_place),
  KEY start_key (to_place, row_start)
) CHARACTER SET utf8mb4
  WITH SYSTEM VERSIONING;

-- 5. Per-year summary for smooth slider playback, built FROM the SVT queries.
CREATE TABLE IF NOT EXISTS heat_year (
  year        SMALLINT NOT NULL,
  place_title VARCHAR(255) NOT NULL,
  knowledge   INT,
  activity    INT,
  controversy INT,
  rewritten   INT,
  PRIMARY KEY (year, place_title)
) CHARACTER SET utf8mb4;
