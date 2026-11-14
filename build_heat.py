"""Stage 4: build the plain summary table heat_year from SVT queries (see heat_sql.py), so the
slider can play smoothly. Also builds the plain `revert` table (from article FOR SYSTEM_TIME ALL).

    .venv\\Scripts\\python build_heat.py          # reverts for the articles in article_list
    .venv\\Scripts\\python build_heat.py --all    # reverts for every article

Rebuilds both tables from scratch every run.
"""
import argparse, time
from common import connect
from heat_sql import REVERTS, METRICS, for_year

YEARS = range(2004, 2027)

parser = argparse.ArgumentParser()
parser.add_argument("--all", action="store_true")
args = parser.parse_args()
scope = "" if args.all else " WHERE page_id IN (SELECT page_id FROM article_list)"

con = connect()
cur = con.cursor()
t_all = time.time()

t = time.time()
cur.execute("DROP TABLE IF EXISTS revert")
cur.execute("""CREATE TABLE revert (page_id INT UNSIGNED NOT NULL, rev_id INT UNSIGNED NOT NULL,
               row_start TIMESTAMP(6) NOT NULL, PRIMARY KEY (page_id, rev_id), KEY (row_start))""")
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
