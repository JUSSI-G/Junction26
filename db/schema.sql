-- Contested History — schema (owner: P1). Applied by `python -m common.schema`.
-- Frozen contract: change only by team agreement, and log it in docs/decisions.md.
--
-- Core idea: we version *sentences*, not just articles. Every distinct sentence of an article is
-- a row in article_sentence; when a revision removes it, MariaDB moves it to history; when a
-- later revision brings the exact same sentence back, it gets a new row with the same sent_hash.
-- So "how many lives did this sentence have" = COUNT(*) FOR SYSTEM_TIME ALL, i.e. edit wars are
-- plain SQL.
--
-- Historical time: the loader writes Wikipedia's real edit times into row_start/row_end with
-- SET system_versioning_insert_history = 1 (MariaDB >= 10.11). A Wikipedia edit time *is* a
-- transaction time, so FOR SYSTEM_TIME AS OF '2012-01-01' means "what Wikipedia said that day".
-- All sessions use time_zone '+00:00' (Wikipedia times are UTC).

-- One row per article; each revision of the article is a history row.
CREATE TABLE IF NOT EXISTS article (
  page_id        INT UNSIGNED NOT NULL,
  title          VARCHAR(512) NOT NULL,
  rev_id         BIGINT UNSIGNED NOT NULL,
  editor         VARCHAR(255),
  anonymous      BOOL NOT NULL DEFAULT 0,      -- IP or temporary account (~2026-…)
  comment        TEXT,
  minor          BOOL NOT NULL DEFAULT 0,
  sha1           CHAR(40),                     -- same hash = same wikitext (reverts)
  n_sentences    INT UNSIGNED NOT NULL DEFAULT 0,
  -- Order of the sentences in this revision: concatenated 32-byte sent_hash values.
  -- Kept here (versioned with the article) so article_sentence rows never have to be updated
  -- just because a sentence moved; an update would create a fake "new life".
  sentence_order MEDIUMBLOB COMPRESSED,
  content        MEDIUMTEXT COMPRESSED,        -- raw wikitext; NULL unless loaded with --with-content
  row_start      TIMESTAMP(6) GENERATED ALWAYS AS ROW START INVISIBLE,
  row_end        TIMESTAMP(6) GENERATED ALWAYS AS ROW END INVISIBLE,
  PERIOD FOR SYSTEM_TIME (row_start, row_end),
  PRIMARY KEY (page_id),
  KEY rev_key (rev_id),
  KEY title_key (title),
  -- MariaDB's own history index is ordered by row_end; "as of <old date>" otherwise scans every
  -- later version (measured in mariadb-system-versioning-wikipedia).
  KEY start_key (page_id, row_start)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  WITH SYSTEM VERSIONING;

-- One row per (article, distinct sentence) while the sentence is in the article.
CREATE TABLE IF NOT EXISTS article_sentence (
  page_id    INT UNSIGNED NOT NULL,
  sent_hash  BINARY(32) NOT NULL,              -- SHA-256 of the normalised sentence
  position   INT UNSIGNED NOT NULL,            -- position when (re)introduced; current order is in article.sentence_order
  text       TEXT NOT NULL,
  rev_id     BIGINT UNSIGNED NOT NULL,         -- revision that (re)introduced it
  editor     VARCHAR(255),
  anonymous  BOOL NOT NULL DEFAULT 0,
  -- The sentence this one rewrote: removed in the same revision, most similar wording.
  -- Its life ended exactly at this row's row_start, so the chain is walked with
  -- WITH RECURSIVE … JOIN article_sentence FOR SYSTEM_TIME ALL ON (sent_hash, row_end).
  prev_hash  BINARY(32) NULL,
  row_start  TIMESTAMP(6) GENERATED ALWAYS AS ROW START INVISIBLE,
  row_end    TIMESTAMP(6) GENERATED ALWAYS AS ROW END INVISIBLE,
  PERIOD FOR SYSTEM_TIME (row_start, row_end),
  PRIMARY KEY (page_id, sent_hash),            -- MariaDB adds row_end implicitly: many lives allowed
  KEY start_key (page_id, row_start),
  KEY hash_key (sent_hash)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  WITH SYSTEM VERSIONING;

-- Gemma's judgement of a sentence (written by scoring/score.py). Not versioned: a sentence's
-- text never changes, so neither does its score. Keyed by hash, shared across articles.
CREATE TABLE IF NOT EXISTS sentence_score (
  sent_hash    BINARY(32) NOT NULL PRIMARY KEY,
  event_name   VARCHAR(255),                   -- name used for the article's main event, if any
  tone         ENUM('neutral','loaded','partisan'),
  neutrality   DECIMAL(3,2),                   -- 0 = partisan … 1 = neutral
  loaded_terms JSON,
  model        VARCHAR(64),
  scored_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY event_key (event_name)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- BITEMPORAL: the second time axis. article_sentence's system time says *when Wikipedia said
-- it*; this application-time period says *when the events the sentence talks about happened*
-- (from the years it mentions: "1918", "6.12.1917", "1800-luvulla" -> 1800-01-01 .. 1900-01-01).
-- Together: "what did Wikipedia say on 2012-01-01 about the events of 1917-1918?" =
--   article_sentence FOR SYSTEM_TIME AS OF '2012-01-01'  JOIN  event_from < 1919 AND event_to > 1917.
-- Keyed by hash: a sentence's text decides what it is about. Sentences without years have no row.
CREATE TABLE IF NOT EXISTS sentence_event_time (
  sent_hash   BINARY(32) NOT NULL PRIMARY KEY,
  event_from  DATE NOT NULL,
  event_to    DATE NOT NULL,                  -- exclusive, as in every MariaDB period
  source      VARCHAR(32) NOT NULL DEFAULT 'years-regex',
  PERIOD FOR event_time (event_from, event_to),
  KEY event_time_key (event_from, event_to)
) CHARACTER SET utf8mb4;

-- Where an article is on Earth (for the globe). From the article's own coordinates, or the place
-- its infobox names (source = 'place:<title>'). Not versioned: we place the article where it is now.
-- pt is a MariaDB spatial POINT(lon lat) with a SPATIAL INDEX: "what is near where I clicked"
-- is MBRContains + ST_Distance_Sphere.
CREATE TABLE IF NOT EXISTS article_geo (
  page_id  INT UNSIGNED NOT NULL PRIMARY KEY,
  lat      DOUBLE NOT NULL,
  lon      DOUBLE NOT NULL,
  pt       POINT NOT NULL,
  source   VARCHAR(300),
  SPATIAL INDEX (pt)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Per-article history summary, written once at load time (ingest/replay.py; backfill with
-- python -m ingest.stats). The globe reads this instead of re-aggregating 800k revisions and
-- 1.4M sentence lives on every request.
CREATE TABLE IF NOT EXISTS article_stats (
  page_id             INT UNSIGNED NOT NULL PRIMARY KEY,
  title               VARCHAR(512),               -- copies of the current article row, so the article
  n_sentences         INT UNSIGNED,               -- picker never scans the history rows of `article`
  revisions           INT UNSIGNED NOT NULL,
  reverts             INT UNSIGNED NOT NULL,      -- wikitext identical to an earlier version, not the previous one
  lives               INT UNSIGNED NOT NULL,      -- article_sentence rows, all system time
  distinct_sentences  INT UNSIGNED NOT NULL,      -- returns = lives - distinct_sentences
  first_rev           TIMESTAMP(6) NULL,
  last_rev            TIMESTAMP(6) NULL,
  KEY title_key (title)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Load bookkeeping: makes the loader resumable and feeds /stats.
CREATE TABLE IF NOT EXISTS load_log (
  page_id     INT UNSIGNED NOT NULL PRIMARY KEY,
  dataset     VARCHAR(32) NOT NULL,
  revisions   INT UNSIGNED NOT NULL,
  lifetimes   INT UNSIGNED NOT NULL,
  seconds     DOUBLE NOT NULL,
  loaded_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4;
