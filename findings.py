r"""Runs the queries behind docs/findings.md and prints each SQL with its result and time.

    .venv\Scripts\python findings.py > data\findings_raw.txt

Takes about 10 minutes at full scale (the term counts read every article's text 24 times).
"""
import sys, time
from common import connect

con = connect()
cur = con.cursor()


def run(title, sql, show=True):
    t = time.time()
    cur.execute(sql)
    rows = cur.fetchall()
    cols = [d[0] for d in cur.description]
    if show:
        print(f"\n=== {title} ({time.time() - t:.1f} s)\n{sql.strip()}\n")
        print(" | ".join(cols))
        for r in rows:
            print(" | ".join("" if v is None else str(v) for v in r))
        sys.stdout.flush()
    return rows


# 1. Most rewritten places
run("1a. Places with the most link changes (links added + removed, whole history)", """
SELECT to_place, COUNT(*) AS added, SUM(row_end < NOW()) AS removed,
       COUNT(*) + SUM(row_end < NOW()) AS changes
FROM place_link FOR SYSTEM_TIME ALL
GROUP BY to_place ORDER BY changes DESC LIMIT 12""")
run("1b. Places that lost the largest share of their links (at least 150 links ever)", """
SELECT to_place, COUNT(*) AS added, SUM(row_end < NOW()) AS removed,
       ROUND(100 * SUM(row_end < NOW()) / COUNT(*)) AS pct_removed
FROM place_link FOR SYSTEM_TIME ALL
GROUP BY to_place HAVING added >= 150 ORDER BY pct_removed DESC LIMIT 12""")

# 2. The busiest year, and why
run("2a. Place links added / removed per year", """
SELECT y, SUM(added) AS added, SUM(removed) AS removed FROM (
  SELECT YEAR(row_start) AS y, COUNT(*) AS added, 0 AS removed
  FROM place_link FOR SYSTEM_TIME ALL GROUP BY y
  UNION ALL
  SELECT YEAR(row_end), 0, COUNT(*)
  FROM place_link FOR SYSTEM_TIME ALL WHERE row_end < NOW() GROUP BY 1) t
GROUP BY y ORDER BY y""")
run("2b. Versions saved and articles created per year", """
SELECT YEAR(v.row_start) AS y, COUNT(*) AS versions_saved, SUM(v.row_start = f.first) AS articles_created
FROM article FOR SYSTEM_TIME ALL v
JOIN (SELECT page_id, MIN(row_start) AS first FROM article FOR SYSTEM_TIME ALL GROUP BY page_id) f
  ON f.page_id = v.page_id
GROUP BY y ORDER BY y""")
run("2c. Reverts per year (revert table: built from article FOR SYSTEM_TIME ALL, see heat_sql.REVERTS)", """
SELECT YEAR(row_start) AS y, COUNT(*) AS reverts FROM revert GROUP BY y ORDER BY y""")

# 3. Most reverted articles
run("3a. Most reverted articles", """
SELECT a.title, r.reverts,
       (SELECT COUNT(*) FROM article FOR SYSTEM_TIME ALL v WHERE v.page_id = r.page_id) AS versions
FROM (SELECT page_id, COUNT(*) AS reverts FROM revert GROUP BY page_id ORDER BY reverts DESC LIMIT 12) r
JOIN article a ON a.page_id = r.page_id
ORDER BY r.reverts DESC""")
run("3b. Share of each top article's versions that are reverts, and its worst year", """
SELECT a.title, t.y AS worst_year, t.n AS reverts_that_year
FROM (SELECT page_id, YEAR(row_start) AS y, COUNT(*) AS n,
             ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY COUNT(*) DESC) AS rn
      FROM revert GROUP BY page_id, y) t
JOIN (SELECT page_id FROM revert GROUP BY page_id ORDER BY COUNT(*) DESC LIMIT 5) top ON top.page_id = t.page_id
JOIN article a ON a.page_id = t.page_id
WHERE t.rn = 1 ORDER BY t.n DESC""")

# 4. Links that moved: one place swapped for another in the same edit
run("4a. Clean swaps: edits that removed exactly one place link and added exactly one", """
WITH removed AS (SELECT page_id, row_end AS t, MIN(to_place) AS place
                 FROM place_link FOR SYSTEM_TIME ALL WHERE row_end < NOW()
                 GROUP BY page_id, row_end HAVING COUNT(*) = 1),
     added AS (SELECT page_id, row_start AS t, MIN(to_place) AS place
               FROM place_link FOR SYSTEM_TIME ALL
               GROUP BY page_id, row_start HAVING COUNT(*) = 1)
SELECT removed.place AS link_removed, added.place AS link_added, COUNT(*) AS edits
FROM removed JOIN added ON added.page_id = removed.page_id AND added.t = removed.t
GROUP BY 1, 2 ORDER BY edits DESC LIMIT 25""")
years = range(2004, 2027)
names = ["Venäjä", "Venäjän keisarikunta", "Neuvostoliitto", "Saksa", "Natsi-Saksa", "Saksan keisarikunta"]
print("\n=== 4b. Articles linking each place, as of 1 January\n"
      "SELECT to_place, COUNT(*) FROM place_link FOR SYSTEM_TIME AS OF TIMESTAMP'<year>-01-01 00:00:00'\n"
      "WHERE to_place IN (" + ", ".join(f"'{n}'" for n in names) + ") GROUP BY to_place\n")
print("year | " + " | ".join(names))
for y in years:
    rows = dict(run("", f"""SELECT to_place, COUNT(*) FROM place_link
                            FOR SYSTEM_TIME AS OF TIMESTAMP'{y}-01-01 00:00:00'
                            WHERE to_place IN ({", ".join("'" + n + "'" for n in names)})
                            GROUP BY to_place""", show=False))
    print(f"{y} | " + " | ".join(str(rows.get(n, 0)) for n in names))
sys.stdout.flush()

# 5. What the 1918 war is called, in the articles as they stood each 1 January
TERMS = """SELECT COUNT(*) AS articles,
       SUM(text LIKE '%vapausso%') AS vapaussota,
       SUM(text LIKE '%sisällisso%') AS sisallissota,
       SUM(text LIKE '%kansalaisso%') AS kansalaissota,
       SUM(text LIKE '%punakapina%') AS punakapina,
       SUM(text LIKE '%vapausso%' AND text LIKE '%sisällisso%') AS both_terms
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP'{y}-01-01 00:00:00'"""
print("\n=== 5. Articles whose text contains each name of the 1918 war, as of 1 January\n"
      + TERMS.format(y="<year>") + "\n")
print("year | articles | vapaussota | sisallissota | kansalaissota | punakapina | both_terms | seconds")
for y in list(years) + [2027]:
    t = time.time()
    r = run("", TERMS.format(y=y), show=False)[0]
    print(f"{'now' if y == 2027 else y} | " + " | ".join(str(v or 0) for v in r) + f" | {time.time() - t:.0f}")
    sys.stdout.flush()
con.close()
