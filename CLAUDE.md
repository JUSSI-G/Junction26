# Rewritten — how Finnish Wikipedia told its history

Junction 2026 project. Main challenge: **MariaDB "Wikipedia Through Time", SVT track** (system-versioned
tables). Side challenge: **Verda Compute Track** (optional, later).

## The product

A **3D globe with a year slider (2004–2026)**. Press play and watch where Finnish Wikipedia wrote about
Finland's history:

- **Heatmap** on the globe: how much each place is written about, as Wikipedia stood on that date.
- **Animated arcs** between places: an article about place A links place B.
  - green = link **added** that year
  - red, fading = link **removed** that year
  - faint grey = unchanged
- **Click a hotspot**: the camera flies in and a side panel shows the article *as it stood on the
  slider date*, with a link to `https://fi.wikipedia.org/?oldid=<rev_id>`.
- **Heat toggle** (in this order of priority): knowledge (amount written) → activity (edits that year) →
  controversy (reverts that year) → rewritten (changes since the previous year).

Demo story: the 1918 civil war (*Suomen sisällissota*, page_id 1150). Tampere flares up, and the story is
rewritten over the years.

Everything time-related must come from **MariaDB system-versioned tables queried with `FOR SYSTEM_TIME`**.
That is what the judges score. Show the real SQL in the UI (a small "SQL" drawer showing the query behind
the current view).

## Judging (MariaDB challenge, 20 % each)

Effective and creative use of MariaDB SVT · implementation and scale across the datasets ·
usefulness for readers/editors · design and demo quality · originality. Bonus for SVT ambition.
MariaDB's own example already does a single-article time machine. **Don't rebuild that.** Our edge is
questions across the whole collection, place links over time, and the globe.

## Reference material (read-only, in `reference/`)

- `reference/mariadb-system-versioning-wikipedia` — **start here.** `schema.sql`, `load.py` (how history
  rows are written with real Wikipedia times via `system_versioning_insert_history`), `history.py` (wikitext
  cleaning), `docker-compose.yml`, `common.py` (connection).
- `reference/mariadb-wikipedia-datasets` — README describes datasets S, M, L.
- `reference/mariadb-vector-wikipedia-rag` — not needed now. Has `article-categories-fi.tsv` and the
  category tree if useful.

## Data

**Dataset M** (in `data/m/`, downloaded from the `m-2026-10` release of mariadb-wikipedia-datasets):
`versions-01.parquet` … `versions-16.parquet` — 862,076 versions of 19,742 articles. Columns: `page_id`,
`title`, `rev_id`, `parent_id`, `timestamp` (UTC), `user`, `anonymous`, `comment`, `minor`, `sha1`, `bytes`,
`text` (raw wikitext). Oldest first per article.

- Same `sha1` as an earlier version that isn't the one just before it = a **revert**.
- Plan for ~5–7 GB in MariaDB with `COMPRESSED` text columns.
- **Always develop on the 50 articles first** (`reference/mariadb-system-versioning-wikipedia/data/articles.tsv`,
  includes Suomen sisällissota, Talvisota, Jatkosota, Mannerheim…). Load all ~19,750 only once the
  pipeline works.

**Coordinates**: from Wikidata (property P625). Look them up by Finnish title via the Wikidata API
(`wbgetentities`, `sites=fiwiki`, `titles=` up to 50 per request, `redirects=yes`, `props=claims|sitelinks`).
Set a descriptive User-Agent. Cache the results in `data/places.tsv`
(`title`, `qid`, `lat`, `lon`, `kind`) so the API is called only once per title.

## Environment

- **Windows PC.** MariaDB is installed natively as a Windows service (no Docker). Connection settings are in
  `.env` (`DB_HOST=127.0.0.1`, `DB_PORT=3306`, `DB_USER`, `DB_PASSWORD`, `DB_NAME=wiki`); never hard-code them,
  and gitignore `.env`.
- Python: use the venv in `.venv` (`.venv\Scripts\python`). Write commands for PowerShell.

## Schema (MariaDB 11.7+)

```sql
-- 1. Article text history: copy reference schema.sql (article table, WITH SYSTEM VERSIONING,
--    real times via system_versioning_insert_history, KEY start_key (page_id, row_start)).

-- 2. Places (plain table): every link target that has coordinates.
CREATE TABLE place (
  title VARCHAR(255) PRIMARY KEY, qid VARCHAR(20), lat DOUBLE, lon DOUBLE, kind VARCHAR(50)
);

-- 3. The article's own location (plain): from its own P625, else its event location (P276 → P625).
CREATE TABLE page_place (page_id INT UNSIGNED PRIMARY KEY, place_title VARCHAR(255));

-- 4. Place links over time: SYSTEM-VERSIONED, one row per (page, linked place).
--    A row exists from the first version containing the link to the first version without it.
--    If the link comes back later, that's a new history row.
CREATE TABLE place_link (
  page_id     INT UNSIGNED NOT NULL,
  to_place    VARCHAR(255) NOT NULL,
  mentions    SMALLINT UNSIGNED NOT NULL,   -- how many times linked in that version
  row_start   TIMESTAMP(6) GENERATED ALWAYS AS ROW START INVISIBLE,
  row_end     TIMESTAMP(6) GENERATED ALWAYS AS ROW END INVISIBLE,
  PERIOD FOR SYSTEM_TIME (row_start, row_end),
  PRIMARY KEY (page_id, to_place),
  KEY start_key (to_place, row_start)
) CHARACTER SET utf8mb4 WITH SYSTEM VERSIONING;

-- 5. Precomputed per-year summary for smooth slider playback (plain table, built FROM SVT queries).
CREATE TABLE heat_year (year SMALLINT, place_title VARCHAR(255), knowledge INT, activity INT,
                        controversy INT, rewritten INT, PRIMARY KEY (year, place_title));
```

Rules:
- Every script sets `time_zone = '+00:00'`.
- History rows are written with `SET system_versioning_insert_history = 1` and explicit `row_start`/`row_end`,
  exactly like the reference `load.py`. Two changes in the same second: shift by 1 µs to keep the order.
- Send batches by size, not row count (16 MB packet limit).

## Link extraction (from wikitext)

- Regex for `[[Target]]` and `[[Target|label]]`. Strip `#section`. Replace `_` with a space. Uppercase the first letter.
- Skip namespaces: `Luokka:`, `Tiedosto:`, `Kuva:`, `File:`, `Image:`, `Category:`, `Wikipedia:`, `Malline:`,
  language links (`en:`, `sv:` …).
- Keep only targets found in `place`.
- **Noise filter (important):** vandalism that blanks a page and is reverted minutes later would create
  floods of red then green arcs. Skip a version when it is undone by a revert (a later version has the same
  `sha1` as the one before it) within 48 hours. Log how many were skipped.

## Key queries (the API should use these shapes)

```sql
-- Links as of a date
SELECT pp.place_title AS from_place, l.to_place, COUNT(*) AS weight
FROM place_link FOR SYSTEM_TIME AS OF TIMESTAMP'2010-01-01 00:00:00' l
JOIN page_place pp USING (page_id)
GROUP BY 1, 2 ORDER BY weight DESC LIMIT 200;

-- Added during a year (green) / removed during a year (red)
SELECT page_id, to_place FROM place_link FOR SYSTEM_TIME ALL
WHERE row_start >= '2018-01-01' AND row_start < '2019-01-01';
SELECT page_id, to_place FROM place_link FOR SYSTEM_TIME ALL
WHERE row_end   >= '2018-01-01' AND row_end   < '2019-01-01';

-- Article as it stood on a date
SELECT rev_id, title, text, row_start FROM article
FOR SYSTEM_TIME AS OF TIMESTAMP'2010-01-01 00:00:00' WHERE page_id = 1150;
```

Heat: knowledge = number of `place_link` rows pointing to the place as of 1 Jan of the year (plus page
length if the article has its own location). activity = versions saved that year for articles at or
linking the place. controversy = reverts that year. rewritten = links added + removed that year.

## Stack

- Python 3.11+, `mariadb` connector, `pyarrow` or `duckdb` for Parquet, FastAPI + uvicorn for the API.
- Frontend: one Vite app (or a single static page) with **globe.gl** (`heatmapsData`, `arcsData` with
  `arcDashAnimateTime`, `pointsData`, `pointOfView` for fly-to). Year slider with play/pause. Side panel for
  the article. SQL drawer.
- MariaDB runs locally as a Windows service (see Environment).

## API

- `GET /api/years` → available years.
- `GET /api/heat?year=&metric=` → `[{title, lat, lon, value}]` (from `heat_year`).
- `GET /api/arcs?year=&limit=` → `[{from:{title,lat,lon}, to:{…}, weight, status: added|removed|same}]`.
- `GET /api/place/{title}?date=` → articles at or linking this place as of the date.
- `GET /api/article/{page_id}?date=` → text as of the date (cleaned like reference `history.py`), rev_id,
  edit count and reverts up to that date.
- Every response includes `"sql": "<the query that produced it>"` for the SQL drawer.

## Build stages (stop and show results after each one)

1. **Setup**: connect to the local MariaDB using `.env`, create the `wiki` database and tables, write `load_parquet.py` to load the 50 articles from
   `data/m/*.parquet` into `article` with real times. Check: `AS OF '2010-01-01'` for page 1150 returns a version
   from before that date.
2. **Places**: extract all link targets across the 50 articles' versions, look them up on Wikidata, fill `place`
   and `page_place`. Report: how many targets, how many have coordinates, top 30 places.
3. **Place links**: build `place_link` with real lifetimes and the noise filter. Report per year: links
   added/removed. Sanity check with Suomen sisällissota.
4. **Heat table + API**.
5. **Globe frontend**: heatmap + arcs + slider + play, then click → side panel, then the SQL drawer.
6. **Scale**: load all ~19,750 articles, rerun 2–4, measure load time and query times. Write the numbers in
   `NOTES.md`.
7. **Gemma on Verda (side challenges: Verda Compute Track + Best Use of Gemma).** Batch job: for every
   revert and every removed/added place link, give Gemma the diff + edit summary, store a one-line reason and
   a label (vandalism / rename / factual change / framing dispute / cleanup) in a `change_reason` table.
   First test the prompt on 10 diffs from page 1150 (check Finnish quality; compare a small and a larger
   Gemma). Then run it over everything as a Verda batch job. Show the reasons in arc tooltips and the
   controversy view, labelled "explained by Gemma". Log model, run time and cost in `NOTES.md`.

## Working rules

- Keep `NOTES.md` up to date: decisions, measured times and row counts, problems hit. It becomes the README and
  the Verda process write-up.
- Don't commit `data/` (gitignore it).
- Prefer simple, working, demoable over complete. The demo is 3 minutes.
- Ask before downloading anything over 1 GB or running the full load.
