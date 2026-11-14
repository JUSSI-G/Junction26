# Merge plan: Rewritten + Contested History → one app

Branch `combined`, made from `Jussi`. Kristian's `origin/Kristian` was merged in with
`git merge origin/Kristian --allow-unrelated-histories`, so both histories are kept
(`git log --graph` shows both roots). Nothing from either side was dropped. Files were moved, not
rewritten, wherever possible (`git log --follow` works on them).

| | Jussi: Rewritten | Kristian: Contested History |
|---|---|---|
| question | *where* Finnish history is written, and how place links change | *which sentences* keep being rewritten |
| system-versioned tables | `article`, `place_link` | `article`, `article_sentence` |
| derived tables | `place`, `page_place`, `heat_year`, `revert`, `page_origin`, `arc_year`, `year_caption` | `sentence_score`, `sentence_event_time` (bitemporal), `article_geo` (spatial), `article_stats`, `load_log` |
| frontend | vanilla JS + globe.gl: heat, arcs, year slider, SQL drawer | React + react-globe.gl + Recharts: globe, time slider, contested map, edit wars, drift |
| AI | stage 7: `change_reason` (why a link changed) | `scoring/`: `sentence_score` (event name, tone) |

## 1. Target layout

```
api/            one FastAPI app
  main.py         the app; sentence routes; mounts the two frontends
  places.py       place routes (APIRouter)                 ← was api.py
  history.py      sentence queries      models.py   response models
  db.py           NEW: one connection pool + one error policy for both routers
  textclean.py    wikitext → readable blocks (panel)       ← was textclean.py
  check_api.py    times every endpoint                     ← was check_api.py
  tests/          test_history.py, test_sentences.py (Kristian) + test_places.py (NEW)
common/
  db.py           the one connection module (pymysql, .env, UTC, pool)  ← replaces common.py
  schema.py       creates every table from db/schema.sql (guarded --reset)
  migrate.py      NEW: brings a pre-merge `article` to the unified shape (instant ALTERs)
ingest/
  load_articles.py, replay.py, history.py, sentences.py, geo.py, event_time.py, stats.py,
  synthetic.py, download.py                                (Kristian: sentences)
  load_parquet.py, links.py, kinds.py, places.py, labels_en.py, place_links.py,
  build_heat.py, check_stage1.py                           (Jussi: places, moved from the root)
scoring/          score.py, eval.py, prompt.txt            (Kristian; stage 7 Gemma goes here too)
db/
  schema.sql      THE schema: both parts             ← Kristian's + schema.sql merged
  queries/*.sql   sentence views (Kristian)
  heat_sql.py     place SVT queries (shown in the SQL drawer)  ← was heat_sql.py
  findings.py, findings_extra.py   pitch numbers           ← moved from the root
  benchmark.py
web/              React app (Kristian) — becomes THE frontend, served at /contested/ for now
web/globe/        the place globe (Jussi), served at / for now   ← was web/
docs/             decisions.md, numbers.md, process-log.md (Kristian); findings.md, merge-plan.md,
                  screenshots/ (Jussi)
dev.py, Makefile, Dockerfile, docker-compose.yml   (Kristian; dev.py gains `places`, `places-dev`)
NOTES.md          the build journal (Jussi), continues
```

## 2. One `article` table: all versions, both sets of columns

```
page_id, title, rev_id, parent_id, editor, anonymous, comment, minor, sha1, len,
n_sentences, sentence_order, content, row_start, row_end
```
- **All versions are kept**, vandalism included. Each view filters for itself:
  the place views skip versions undone within 48 h (`ingest/place_links.py`); the sentence views
  apply Kristian's blanking filter **only when building `article_sentence`** (`ingest/history.py`).
- `content` (raw wikitext) is always loaded (the place build needs it; Kristian's loader made it
  optional with `--with-content`).
- The live table (loaded before the merge) was migrated by `python -m common.migrate`:
  `user → editor`, `text → content`, `+ n_sentences`, `+ sentence_order`, `title → VARCHAR(512)`
  (all `ALGORITHM=INSTANT`, 0.3 s total, history kept), then `+ rev_key`, `+ title_key` (inplace).
  `n_sentences` / `sentence_order` are empty on the 862,076 existing rows until stage 2 (below).

## 3. One API, two routers

`uvicorn api.main:app --port 8000` serves everything. Every route that existed on either side
still exists at the same path:
- place routes (`api/places.py`): `/api/years`, `/api/heat`, `/api/arcs`, `/api/captions`,
  `/api/place/{title}`, `/api/article/{page_id}`; every response keeps its `sql` and `ms`;
- sentence routes (`api/main.py`): `/api/health`, `/api/articles`, `/api/articles/{id}/as-of|diff|
  contested|edit-wars|drift|term-drift|revisions|about`, `/api/articles/{id}/sentences/{hash}/history`,
  `/api/about`, `/api/revisions/{rev_id}`, `/api/map`, `/api/map/near`, `/api/stats`.

A route whose tables are not loaded yet answers **503 with the loader to run** (`api/db.py`), never
a 500. Static: `/` = place globe (`web/globe/dist`), `/contested/` = React app (`web/dist`, built
with Vite `base: '/contested/'`).

## 4. Conflicts found, and how each is resolved

### Git (the merge itself)
| # | conflict | resolution |
|---|---|---|
| 1 | `.gitignore` (add/add, the only textual conflict) | union of both; `web/dist/` and `web/globe/dist/` |
| 2 | `web/` on both sides (`index.html`, `package.json`, `package-lock.json`, `vite.config.js`, `src/`, `public/earth-topology.png`, `public/night-sky.png`) | before merging, mine moved to `web/globe/` (own commit), so git saw no collision |
| 3 | `api.py` (module) vs `api/` (package): same import name | `api.py` → `api/places.py`, an `APIRouter` |
| 4 | `common.py` vs `common/` (package) | `common.py` removed; everything uses Kristian's `common/db.py` |
| 5 | root `schema.sql` vs `db/schema.sql` | one `db/schema.sql`: Kristian's tables, then the place tables (`create_tables.py` removed; `python -m common.schema` creates all) |
| 6 | README: Kristian's `README.md` at the root; mine is `NOTES.md` (+ the `Junction26` submodule's README) | Kristian's README stays the README for now with a pointer to the combined layout; the final README is written in the frontend stage from both. `NOTES.md` stays the journal |
| 7 | requirements: `requirements.txt` (Kristian: fastapi, uvicorn, pymysql, pyarrow, httpx, pytest) vs my venv (`mariadb` connector, duckdb) | Kristian's file unchanged: my scripts were ported to pymysql, so `mariadb` and `duckdb` are no longer needed |
| 8 | `.env.example` (Kristian) vs my `.env` only | one `.env.example`; `DB_PORT=3307` (our MariaDB 13 service; 3306 is MySQL 8 on that PC), `DB_NAME=wiki` |

### Database
| # | conflict | resolution |
|---|---|---|
| 9 | two `article` definitions: `user` vs `editor`, `text` vs `content`, `parent_id`/`len` vs `n_sentences`/`sentence_order` | one table with all columns (§2); names from Kristian (`editor` matches `article_sentence.editor`; `text` is the sentence text there) |
| 10 | column types: `rev_id INT` vs `BIGINT`, `sha1 CHAR(31)` vs `CHAR(40)`, `title VARCHAR(255)` vs `512`, collation `uca1400_ai_ci` vs `unicode_ci` | schema uses Kristian's types; the live table keeps INT / CHAR(31) / uca1400 (changing them rebuilds 5.9 GB; values fit). `common.migrate` lists them as known differences |
| 11 | vandalism: Kristian's loader **left blanked versions out of `article`**; mine keeps every version | `article` keeps every version; the blanking filter runs only when building sentences (§2). Needs a loader change in stage 2 |
| 12 | two connectors and placeholder styles: `mariadb` + `?` (mine) vs `pymysql` + `%s` / `%(name)s` (Kristian) | pymysql everywhere; my scripts use `%s`; my router keeps `?` in the SQL it *shows* (SQL drawer) and converts when executing |
| 13 | collation of title joins: place tables `utf8mb4_bin` (so `Salla` ≠ `Šalla`), Kristian's `unicode_ci` | no conflict today: the two halves join on `page_id`, never on title. Rule: keep joins on ids |
| 14 | `common.schema --reset` drops every table: fine for `wiki_test`, fatal on our loaded `wiki` | `--reset` now refuses when `article` holds > 100,000 versions unless `ALLOW_RESET=1`; Kristian's tests keep using `wiki_test` |
| 15 | revert counts: `article_stats.reverts` counts over the *filtered* versions, my `revert` table over *all* versions | one definition (sha1 equal to an earlier version, not the previous one) over all versions in `article`; `article_stats` will be computed from it in stage 2 |

### Overlapping features (decide later, nothing removed now)
| # | overlap | plan |
|---|---|---|
| 16 | where an article is: `article_geo` (own `{{coord}}` / infobox place, POINT + SPATIAL INDEX) vs `page_place` (Wikidata P625, else P276) | stage 2: `page_place` first, `article_geo` as fallback; fill `article_geo.pt` from the merged answer so `/api/map/near` keeps its spatial index |
| 17 | two globes: Kristian's `GlobeView` (contestedness per article) vs mine (places, link arcs, heat) | frontend stage: mine ported to a React component as the landing view (both use globe.gl); "contested" becomes a fifth metric on it |
| 18 | two wikitext cleaners: `api/textclean.py` (panel) vs `ingest/sentences.clean_wikitext` (sentence splitting) | keep both (different outputs); the panel could switch to sentences once `article_sentence` is loaded |
| 19 | `/api/article/{id}` (mine, one version as text + SQL) vs `/api/articles/{id}/as-of` (Kristian, sentences) | both kept; the React panel uses `as-of` when sentences are loaded, `article` otherwise |
| 20 | SQL drawer: my responses carry `sql`; Kristian's use `response_model` without it | frontend stage: add `sql` to Kristian's models (CLAUDE.md requires the SQL behind every view) |
| 21 | AI: my stage-7 `change_reason` (why an edit changed links) vs Kristian's `sentence_score` (tone, event name) | both, one client: `scoring/score.py` backends (`llm` / `heuristic`) serve both prompts |
| 22 | "controversy" (reverts, mine) vs "contested" (sentence returns + reverts, Kristian) | keep both names as two metrics, each explained in its tooltip |
| 23 | 50-article dev list: `reference/…/articles.tsv` vs `ingest/lists/small.tsv` | identical (same 50 page ids, checked); `small.tsv` is the one to use |
| 24 | Docker image builds only `web/`, not `web/globe/` | frontend stage (the globe moves into the React app) |
| 25 | `CLAUDE.md` says MariaDB is on 3306 | stale; `.env` / `.env.example` are the source of truth (3307) |

## 5. Stages

1. **Backend (this stage, done):** layout, one schema, one connection module, both routers, both
   old frontends served. Place pipeline rerun from the new packages; both test suites green.
2. **Sentence data into `wiki`** (ask first: it rewrites `article`):
   - extend `ingest/replay.py` to write **all** revisions to `article` (with `parent_id`, `len`,
     `content`) and build `article_sentence` from the filtered ones (decide: a dropped vandal
     revision gets the `sentence_order` of the last kept one, so a snapshot never shows vandal text);
   - load into `article_new`, check, then `RENAME TABLE article TO article_old, article_new TO article`
     (the app stays up; `article_old` dropped only after the checks pass);
   - then `ingest.geo` (merged with `page_place`, #16), `ingest.event_time`, `ingest.stats`, scoring.
3. **Frontend:** React app with my globe as the landing view, Kristian's views as tabs, one SQL
   drawer; then `web/globe/` is retired and `/contested/` redirects.
4. **Stage 7 (Gemma on Verda):** `change_reason` + `sentence_score` from one Verda batch job.

## 6. Checks at the end of stage 1

See NOTES.md, "Combined app, stage 1", for the numbers.
