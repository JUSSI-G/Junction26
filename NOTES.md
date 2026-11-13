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
