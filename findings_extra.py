r"""Extra queries for docs/findings.md (non-country places, war names without the medal, Halonen by month).

    .venv\Scripts\python findings_extra.py > data\findings_extra.txt
"""
import sys, time
from common import connect

con = connect()
cur = con.cursor()


def show(title, sql):
    t = time.time()
    cur.execute(sql)
    rows = cur.fetchall()
    print(f"\n=== {title} ({time.time() - t:.1f} s)\n{sql.strip()}\n")
    print(" | ".join(d[0] for d in cur.description))
    for r in rows:
        print(" | ".join("" if v is None else str(v) for v in r))
    sys.stdout.flush()
    return rows


show("1. Most rewritten places that are not countries", """
SELECT l.to_place, p.kind, COUNT(*) AS added, SUM(l.row_end < NOW()) AS removed,
       COUNT(*) + SUM(l.row_end < NOW()) AS changes
FROM place_link FOR SYSTEM_TIME ALL l
JOIN place p ON p.title = l.to_place
WHERE p.is_country = 0
GROUP BY l.to_place, p.kind ORDER BY changes DESC LIMIT 10""")

show("3a. Tarja Halonen: versions saved and reverts per month, July 2005 - June 2007", """
SELECT DATE_FORMAT(v.row_start, '%Y-%m') AS month, COUNT(*) AS versions, COUNT(r.rev_id) AS reverts
FROM article FOR SYSTEM_TIME ALL v
LEFT JOIN revert r ON r.page_id = v.page_id AND r.rev_id = v.rev_id
WHERE v.page_id = (SELECT page_id FROM article WHERE title = 'Tarja Halonen')
  AND v.row_start >= '2005-07-01' AND v.row_start < '2007-07-01'
GROUP BY month ORDER BY month""")
show("3b. Tarja Halonen: reverts per year", """
SELECT YEAR(row_start) AS y, COUNT(*) AS reverts FROM revert
WHERE page_id = (SELECT page_id FROM article WHERE title = 'Tarja Halonen')
GROUP BY y ORDER BY y""")

# The medal "Vapaussodan muistomitali" (Liberation War commemorative medal) appears in hundreds of
# soldier biographies. Removing that phrase first shows who uses "vapaussota" for the war itself.
# REPLACE is case-sensitive, so both capitalisations are removed; LIKE is case-insensitive.
TERMS = """SELECT COUNT(*) AS articles,
       SUM(text LIKE '%vapausso%') AS vapaussota_all,
       SUM(REPLACE(REPLACE(text, 'Vapaussodan muistomital', ''), 'vapaussodan muistomital', '')
           LIKE '%vapausso%') AS vapaussota_not_medal,
       SUM(text LIKE '%sisällisso%') AS sisallissota
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP'{y}-01-01 00:00:00'"""
print("\n=== 5. Names of the 1918 war in the articles as they stood each 1 January\n"
      + TERMS.format(y="<year>") + "\n")
print("year | articles | vapaussota_all | vapaussota_not_medal | sisallissota | seconds")
for y in range(2004, 2027):
    t = time.time()
    cur.execute(TERMS.format(y=y))
    print(f"{y} | " + " | ".join(str(v or 0) for v in cur.fetchone()) + f" | {time.time() - t:.0f}")
    sys.stdout.flush()
con.close()
