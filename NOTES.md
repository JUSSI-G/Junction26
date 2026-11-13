# Rewritten — working notes

## Stage 1: setup (2026-11-14) — done

### Result
| step | time |
|---|---|
| `create_tables.py` (database + 6 tables) | 0.16 s |
| `load_parquet.py`: 50 articles, **31,848 versions**, 2,050 MB of wikitext | **82 s** |
| `article` table on disk (COMPRESSED text + indexes) | **921 MB** |

Proof (`check_stage1.py`):
```sql
SELECT rev_id, title, row_start, row_end, len, LEFT(text, 120)
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP'2010-01-01 00:00:00'
WHERE page_id = 1150
```
→ rev_id **7791638** *Suomen sisällissota*, saved 2009-12-29 10:37:52, current until 2010-01-24
16:42:21, 146,453 bytes (https://fi.wikipedia.org/?oldid=7791638). It is the newest version saved
before the date (checked against `FOR SYSTEM_TIME ALL`). Page 1150 has 3,357 versions, the whole set
spans 2003-03-29 … 2026-09-29.

AS OF query times for page 1150 (warm cache): 2004-06-01 0.14 ms (7,358 bytes then!), 2010-01-01
0.33 ms, 2018-01-01 0.19 ms, 2026-01-01 0.07 ms. `COUNT(*) … AS OF '2010-01-01'` over the whole table:
40 articles existed, 4.4 ms.

Login issue on the way: the first `.env` password was rejected by MariaDB (`1045 Access denied`);
fixed by updating `.env`.

### Environment found
- **MariaDB 13.0** runs as the Windows service `MariaDB` on **port 3307** (from its `my.ini`).
  **MySQL 8.0** (`MySQL80`) also runs on this machine, on 3306. Don't mix them up.
- Python 3.14.3 in `.venv`: mariadb 1.1.15, pyarrow 26.0.1, duckdb 2.0.0, fastapi, uvicorn.

### Files
- `common.py`: reads `.env` (handles BOM/CRLF/quotes), `connect()` always sets `time_zone='+00:00'`.
- `schema.sql`: all five tables from CLAUDE.md. `article` is the reference schema plus `parent_id` and
  `anonymous` (both in dataset M).
- `create_tables.py`: `CREATE DATABASE IF NOT EXISTS wiki`, then runs `schema.sql`.
- `load_parquet.py`: loads the 50 dev articles by default; `--list all` loads all 19,742.
- `check_stage1.py`: the `AS OF '2010-01-01'` proof for page 1150.

### Decisions
- **Real times** work like the reference `load.py`: `system_versioning_insert_history = 1`, explicit
  `row_start`/`row_end` (end = the next version's start), and the newest version is inserted without
  `row_end` so it stays current. Edits in the same second are shifted 1 µs apart to keep their order.
- **No `PARTITION BY SYSTEM_TIME`.** The reference measured no speed-up and 25% more disk. Kept
  `KEY start_key (page_id, row_start)`, which gave the reference its speed-up for old dates.
- **Batches are sized by bytes** (8 MB of text per `executemany`), well under the 16 MB packet limit.
- **Streaming parquet read.** Every article sits entirely in one parquet file (checked: 0 of 19,742 are
  split), and page_id ranges are sorted across files. The loader reads one row group at a time, skips
  row groups whose page_id stats hold no wanted article, and writes each article when the next one
  begins, so the full load won't need GBs of RAM.
- **Timestamps:** parquet holds `timestamp[ms, tz=UTC]`. Casting to naive `timestamp[us]` keeps the
  same instant (checked) and avoids needing the tz database, which pyarrow lacks on Windows.

### Data facts (50 dev articles)
- 31,848 versions; all 50 articles found. This matches the reference repo's count from the XML dumps.
- Reading them from parquet with a pyarrow `isin` filter takes 1.3 s.
- sha1 is always 31 chars; 8 versions have a null sha1 (likely deleted revisions).
- A duckdb glob query over all 16 files with `count(DISTINCT …)` hung for more than 2 min; pyarrow
  was instant. Use pyarrow for parquet.
- Load speed: about 390 versions/s, or 25 MB of wikitext/s. At that rate the full dataset M
  (862k versions) would take about 35–40 min, if it scales linearly (to measure in stage 6).

> Note: by the time of stage 2 the `article` table held **all 19,742 articles / 862,076 versions**
> (a full load ran outside these notes, so its time is not recorded). `article_list` still holds the 50
> dev articles, and stage 2 scripts default to that list.

## Stage 2: places (2026-11-14) — done

Run: `.venv\Scripts\python places.py` (50 dev articles; `--all` for every article). Total **488 s**:
link extraction from all 31,848 versions **24 s**, Wikidata/Wikipedia lookups **462 s** (547 API
requests, 12,747 titles). Reruns read `data/places.tsv` and make no lookups.

### Results
| | count |
|---|---|
| distinct link targets (all versions of the 50 articles) | **12,734** |
| … that are existing fi.wikipedia pages (after redirects) | 11,159 |
| … with a Wikidata item | 11,131 |
| … with coordinates (P625, Earth) | **1,701** |
| `place` rows (distinct places after merging redirects) | **1,526** |
| articles with their own location (`page_place`) | **19 of 50**: 9 own P625, 10 via P276 |

Own location via P276: Jatkosota, Talvisota and **Suomen sisällissota → Suomi** (the country, i.e.
Finland's centroid); Lapin sota → Lapin maakunta, Mäntsälän kapina → Mäntsälä, Pariisin rauhansopimus
(1947) → Pariisi, Pähkinäsaaren rauha → Pähkinäsaaren linna, Siirtoväki → Karjalankannas,
Tarton rauha → Tartto, YYA-sopimus → Moskova.
Own P625: Ahvenanmaan kysymys, Anjalan liitto, Isoviha, Mannerheim-linja, Moskovan rauhansopimus
(1940), Porkkalan vuokra-alue, Suomen sota, Suomen suuriruhtinaskunta, Turun palo.
No location (31): mostly decade/election/politics articles (Suomi 1960-luvulla, Eduskuntavaalit 2011 …).

Top 30 places by linking articles, ever / in the current version:
Suomi 38/32 · Helsinki 30/25 · Neuvostoliitto 28/24 · Ruotsi 25/21 · Venäjä 21/6 · Pietari 20/19 ·
Kansallinen Kokoomus 19/18 · Yhdistynyt kuningaskunta 19/15 · Turku 18/15 · Ahvenanmaan maakunta 17/14 ·
Tampere 17/12 · Saksa 17/9 · Ranska 16/12 · Viipuri 16/12 · Venäjän keisarikunta 15/15 ·
Suomen suuriruhtinaskunta 15/14 · Oulu 15/12 · Ruotsin kieli 14/7 · Suomen Pankki 13/12 ·
Karjalankannas 13/11 · Tukholma 13/11 · Puola 13/7 · Petsamo 12/12 · Yhdysvallat 12/10 · Viro 12/9 ·
Natsi-Saksa 11/11 · Neuvosto-Venäjä 11/11 · Karjala 11/8 · Lahti 11/8 · Moskova 11/8.
(Venäjä 21 → 6: links to "Venäjä" were later rewritten to more precise targets such as
Venäjän keisarikunta / Neuvosto-Venäjä — already a "rewritten" story.)

Most common kinds in `place`: municipality of Finland 171, town 75, battle 60, sovereign state 57,
former municipality 42, city 37, village 32, river 28, historical country 23, shopping center 22.

### Decisions
- **Redirects are resolved on fi.wikipedia, not Wikidata.** `wbgetentities&sites=fiwiki&redirects=yes`
  reported redirect titles ("Helsingin kaupunki", "Lapuan liike") as missing. Instead: step 1
  fi.wikipedia `action=query&redirects=1&prop=pageprops` (title → resolved title + QID), step 2
  `wbgetentities&ids=` for P625/P31/P276, step 3 P31 labels for `kind`. All 50 per request, serial.
- **`place.title` is the resolved title.** `data/places.tsv` keeps the title *as linked* plus
  `resolved`, so stage 3 maps link text → place via the cache ("Helsingin kaupunki" counts as Helsinki).
  Extra columns vs CLAUDE.md: `resolved`, `p276`.
- `kind` = English label of the first P31. Coordinates on other globes (Moon …) are ignored.
- **maxlag:** Wikidata kept answering `maxlag` with a steady ~11 s reported lag, so `maxlag=5` stalled
  the run (first attempt crashed after 6 retries). Read-only requests now use `maxlag=30`, honour
  `Retry-After`, back off up to ~15 min, and log every wait.
- The first run accidentally scanned **all 862k versions** (169,720 distinct targets → would have been
  ~7,000 API requests); stopped after <10 requests. Scripts now default to `article_list`.

### Problems / open questions for stage 3
- **Non-places with coordinates:** P625 also exists on parties (Kansallinen Kokoomus — its HQ),
  languages (Ruotsin kieli), banks (Suomen Pankki), shopping centers (22). They would make
  misleading hotspots. Proposal: drop by `kind` (organisations, languages, buildings …) or keep
  only geographic/event kinds.
- **Country-level locations:** the demo article *Suomen sisällissota* sits at "Suomi" (centroid) via
  P276; the arcs from it will start in central Finland. Fine for the globe, but Tampere will only
  flare through linking articles, not as the article's own location.
- Full scale (stage 6): 169,720 targets ≈ 7,000 serial requests ≈ 1.5–2 h at the measured rate.
