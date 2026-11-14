# Contested History

> **Combined app (branch `combined`, mid-merge).** This repository now holds two builds in one
> backend: *Contested History* (below: sentence-level history) and *Rewritten* (places and place
> links over time, the globe; see `NOTES.md`). One schema (`db/schema.sql`), one connection module
> (`common/db.py`), one API (`uvicorn api.main:app`): `/` serves the place globe, `/contested/` the
> React views. Layout, conflicts and next steps: [docs/merge-plan.md](docs/merge-plan.md).
> Local setup on the dev PC: MariaDB 13 service on port 3307 (`.env`, see `.env.example`), no Docker.

**Which parts of Finnish history does Wikipedia keep rewriting, sentence by sentence?**

Junction 2026 · MariaDB *Wikipedia Through Time* (SVT track) · Best Use of Gemma · Best Use of Verda

We don't version articles, we version **sentences**. Every sentence of every revision of a
Finnish Wikipedia article is a row in a MariaDB `WITH SYSTEM VERSIONING` table, stamped with the
real Wikipedia edit time. Edit wars, rewritten history and point-in-time views then become plain
SQL over `FOR SYSTEM_TIME`.

Hero article: *Suomen sisällissota* (the Finnish Civil War of 1918), whose very name is contested
(*sisällissota / vapaussota / punakapina / kansalaissota*). 3,345 revisions from 2003–2026,
8,089 sentence lives. The intro sentence that names the war has been removed and put back 19 times.

## Views

| | View | For | MariaDB feature |
|---|---|---|---|
| V0 | **Globe**: every article with a place, as a heat map of how contested its history is; click → the article through time | everyone | `POINT` + `SPATIAL INDEX`, `MBRContains` + `ST_Distance_Sphere` ("nearby"), window functions over `FOR SYSTEM_TIME ALL` |
| V1 | **Time slider**: the article on any date, and what was added/removed between two dates | readers | `FOR SYSTEM_TIME AS OF`, two snapshots anti-joined |
| V2 | **Contested map**: today's text heat-coloured by rewrites + returns; click a sentence for every earlier wording | editors | `WITH RECURSIVE` over `FOR SYSTEM_TIME ALL` (rewrite chains) |
| V3 | **Edit wars**: sentences that left and came back, with who added and who removed them each time | editors | `GROUP BY … HAVING COUNT(*) > 1` over `FOR SYSTEM_TIME ALL` |
| V1+ | **Bitemporal filter** in the time slider: what the article said *then* about events of *years Y–Z*; also `/api/about` across all of Wikipedia | readers | system time × application-time `PERIOD FOR event_time` |
| V4 | **Narrative drift**: which name the article uses, and how neutral it reads, at the end of every month/quarter/year; click → V1 | both | +1/−1 sweep with `SUM() OVER` over history, joined to Gemma's scores |

## Quick start

Needs Docker, Python 3.11+, Node 18+. No `make` on Windows? Use `python dev.py <task>` instead; it's the same thing.

```bash
pip install -r requirements.txt
python dev.py demo          # MariaDB + synthetic demo article + baseline scores + web build + API
# open http://localhost:8000
```

Real data (dataset M from [MariaDB/mariadb-wikipedia-datasets](https://github.com/MariaDB/mariadb-wikipedia-datasets)):

```bash
python -m ingest.download 01                                  # 20 MB, holds page 1150
python -m ingest.replay --dataset data/m/versions-01.parquet --pages 1150   # ~80 s
python -m scoring.score                                       # keyword baseline, or Gemma (below)
python dev.py api                                             # :8000
python dev.py web                                             # :5173, hot reload
```

| Task | Command |
|---|---|
| Globe data (2,760 placeable articles) | `python -m ingest.download --all` then `python -m ingest.geo` then `GEO_TOP=300 python -m ingest.replay --dataset geo --workers 6` |
| Bitemporal event periods | `python -m ingest.event_time` (after any load) |
| Scale numbers for the slides | `python -m db.benchmark --record` |
| Deploy (Verda CPU / any Docker host) | `docker compose --profile app up -d --build`, then load with `docker compose run --rm app python -m ingest.replay --dataset large --workers 8` |
| Frontend without a backend | `python dev.py web-mock` (uses `web/mocks/*.json`) |
| Regenerate mocks | `python dev.py mocks` |
| Tests (27, need MariaDB) | `python dev.py test` |
| Bigger datasets | `python dev.py ingest small` · `ingest medium` · `ingest large` |
| Gemma scoring | `SCORING_URL=http://<vllm>/v1 GEMMA_MODEL=google/gemma-3-12b-it python -m scoring.score --backend llm` |
| Gemma eval | `python -m scoring.eval --backend llm` (after labelling `scoring/eval/labels.csv`) |

API docs: http://localhost:8000/docs

## How it works

```
dataset M (parquet: every version, wikitext, editor, time)
   │  ingest/load_articles.py   stream pages, skip row groups by page_id statistics
   │  ingest/sentences.py       wikitext → text → Finnish sentences → normalised SHA-256
   │  ingest/history.py         sentence lives per article; rewrite links (prev_hash); vandalism filter
   ▼  ingest/replay.py          SET system_versioning_insert_history = 1; INSERT … row_start, row_end
MariaDB  article            (one row per article, every revision = a history row)
         article_sentence   (one row per sentence life; same hash, several lives = edit war)
         sentence_score     (Gemma: event name, tone, neutrality, loaded terms)
   │  db/queries/*.sql          one file per view
   ▼  api/ (FastAPI)  →  web/ (React + Vite + Recharts)
```

Key choices, measured numbers and the reasons behind them: [docs/decisions.md](docs/decisions.md),
[docs/numbers.md](docs/numbers.md). Verda runbook: [docs/process-log.md](docs/process-log.md).

## Team

| Role | Owns |
|---|---|
| P1 Backend | `db/`, `api/`, `common/` |
| P2 Data | `ingest/` |
| P3 AI | `scoring/`, `docs/process-log.md` |
| P4 Frontend + pitch | `web/`, `pitch/` |

## Licence

Code: TODO, pick a licence and add a LICENSE file before submission. Wikipedia text and anything derived from it: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/),
credit Wikipedia and its authors. `ingest/lists/small.tsv` is from
[MariaDB/mariadb-system-versioning-wikipedia](https://github.com/MariaDB/mariadb-system-versioning-wikipedia) (MIT).
