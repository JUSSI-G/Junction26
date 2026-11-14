"""Stage 4: build the plain summary table heat_year from SVT queries (see heat_sql.py), so the
slider can play smoothly. Also builds the plain `revert` table (from article FOR SYSTEM_TIME ALL).

    .venv\\Scripts\\python -m ingest.build_heat          # reverts for the articles in article_list
    .venv\\Scripts\\python -m ingest.build_heat --all    # reverts for every article

Rebuilds both tables from scratch every run.
"""
import argparse, time
import sys
from common.db import connect
from db.heat_sql import REVERTS, METRICS, ORIGIN, ARCS, YEAR_TOTALS, BIGGEST_EDITS, for_year

YEARS = range(2004, 2027)

parser = argparse.ArgumentParser()
parser.add_argument("--all", action="store_true")
args = parser.parse_args()
scope = "" if args.all else " WHERE page_id IN (SELECT page_id FROM article_list)"

sys.stdout.reconfigure(encoding="utf-8")
con = connect(dict_rows=False)
cur = con.cursor()
t_all = time.time()

t = time.time()
cur.execute("DROP TABLE IF EXISTS revert")
cur.execute("""CREATE TABLE revert (page_id INT UNSIGNED NOT NULL, rev_id INT UNSIGNED NOT NULL,
               row_start TIMESTAMP(6) NOT NULL, PRIMARY KEY (page_id, rev_id), KEY (row_start), KEY page_time (page_id, row_start))""")
cur.execute(REVERTS.format(scope=scope))
cur.execute("SELECT COUNT(*) FROM revert")
print(f"revert: {cur.fetchone()[0]} reverts ({time.time() - t:.1f} s)")

cur.execute("DELETE FROM heat_year")
timings = {}
for metric, statements in METRICS.items():
    t = time.time()
    for year in YEARS:
        for sql in statements:
            cur.execute(for_year(sql, year))
    timings[metric] = time.time() - t
cur.execute("""UPDATE heat_year SET knowledge = COALESCE(knowledge, 0), activity = COALESCE(activity, 0),
               controversy = COALESCE(controversy, 0), rewritten = COALESCE(rewritten, 0)""")
con.commit()
print("heat_year built: " + ", ".join(f"{m} {s:.1f} s" for m, s in timings.items())
      + f" ({len(YEARS)} years)")

t = time.time()
cur.execute("DROP TABLE IF EXISTS page_origin")
cur.execute("""CREATE TABLE page_origin (year SMALLINT NOT NULL, page_id INT UNSIGNED NOT NULL,
               place_title VARCHAR(255) NOT NULL, inferred BOOL NOT NULL,
               PRIMARY KEY (year, page_id)) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin""")
for year in YEARS:
    for sql in ORIGIN:
        cur.execute(for_year(sql, year))
con.commit()
cur.execute("SELECT COUNT(*), SUM(inferred), COUNT(DISTINCT page_id) FROM page_origin")
print("page_origin: %s rows, %s inferred, %s articles" % cur.fetchone() + f" ({time.time() - t:.1f} s)")

# --- arc_year: strongest arcs per year / status / origin type
ARC_CAP = 1500
t = time.time()
cur.execute("DROP TABLE IF EXISTS arc_year")
cur.execute("""CREATE TABLE arc_year (year SMALLINT NOT NULL, status VARCHAR(8) NOT NULL,
               inferred BOOL NOT NULL, rnk INT NOT NULL, from_place VARCHAR(255) NOT NULL,
               to_place VARCHAR(255) NOT NULL, weight INT NOT NULL, articles TEXT,
               PRIMARY KEY (year, status, inferred, rnk)) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin""")
for year in YEARS:
    cur.execute(for_year(ARCS.replace("{cap}", str(ARC_CAP)), year))
con.commit()
cur.execute("SELECT COUNT(*) FROM arc_year")
print(f"arc_year: {cur.fetchone()[0]} rows, top {ARC_CAP} per year/status/origin type ({time.time() - t:.1f} s)")

# --- year_caption: totals + the single edit that changed the most place links (not a new article)
t = time.time()
cur.execute("DROP TABLE IF EXISTS year_caption")
cur.execute("""CREATE TABLE year_caption (year SMALLINT PRIMARY KEY, added INT NOT NULL, removed INT NOT NULL,
               page_id INT UNSIGNED, title VARCHAR(255), rev_id INT UNSIGNED, editor VARCHAR(255),
               comment TEXT, saved TIMESTAMP(6) NULL, n_added INT, n_removed INT) CHARACTER SET utf8mb4""")
for year in YEARS:
    cur.execute(for_year(YEAR_TOTALS, year))
    added, removed = cur.fetchone()
    cur.execute(for_year(BIGGEST_EDITS, year))
    best = None
    for page_id, when, n_added, n_removed in cur.fetchall():
        cur.execute("""SELECT title, rev_id, editor, comment,
                              (SELECT MIN(row_start) FROM article FOR SYSTEM_TIME ALL WHERE page_id = %s) = row_start
                       FROM article FOR SYSTEM_TIME ALL WHERE page_id = %s AND row_start = %s""",
                    (page_id, page_id, when))
        row = cur.fetchone()
        if row and not row[4]:                       # skip "the article was created"
            best = (page_id, row[0], row[1], row[2], row[3], when, int(n_added), int(n_removed))
            break
    cur.execute("INSERT INTO year_caption VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (year, int(added), int(removed)) + (best or (None,) * 8))
con.commit()
print(f"year_caption: {len(YEARS)} rows ({time.time() - t:.1f} s)")
cur.execute("SELECT year, added, removed, title, n_added, n_removed, LEFT(comment, 60) FROM year_caption ORDER BY year")
for r in cur.fetchall():
    print("  {}: +{} -{} | {} (+{} -{}) {!r}".format(*r))

cur.execute("SELECT COUNT(*), COUNT(DISTINCT place_title) FROM heat_year")
rows, places = cur.fetchone()
print(f"heat_year: {rows} rows, {places} places")
print("\nyear  places  knowledge  activity  controversy  rewritten  (sums)")
cur.execute("""SELECT year, COUNT(*), SUM(knowledge), SUM(activity), SUM(controversy), SUM(rewritten)
               FROM heat_year GROUP BY year ORDER BY year""")
for r in cur.fetchall():
    print("{}  {:6}  {:9}  {:8}  {:11}  {:9}".format(*r))
for metric in METRICS:
    cur.execute(f"""SELECT place_title, {metric} FROM heat_year WHERE year = 2018
                    ORDER BY {metric} DESC LIMIT 5""")
    print(f"\ntop 2018 {metric}: " + ", ".join(f"{p} {v}" for p, v in cur.fetchall()))
print(f"\nTotal {time.time() - t_all:.1f} s")
con.close()
