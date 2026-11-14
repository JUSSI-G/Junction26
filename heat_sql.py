"""The SVT queries that build heat_year, one per metric. Shared by build_heat.py (runs them) and
api.py (shows them in the SQL drawer). {y0} = 'YYYY-01-01 00:00:00' of the year, {y1} = next year.

knowledge   = links pointing to the place AS OF 1 Jan, plus the length (KB) of articles located there
activity    = versions saved during the year, of articles located at or linking the place that year
controversy = reverts during the year, same articles (revert: text identical to an earlier version
              but not to the one just before it — the reference repo's definition)
rewritten   = place links to the place added + removed during the year
"""

REVERTS = """
INSERT INTO revert (page_id, rev_id, row_start)
SELECT page_id, rev_id, row_start
FROM (SELECT page_id, rev_id, row_start,
             sha1 <> LAG(sha1) OVER (PARTITION BY page_id ORDER BY row_start)
               AND MIN(row_start) OVER (PARTITION BY page_id, sha1) < row_start AS is_revert
      FROM article FOR SYSTEM_TIME ALL{scope}) v
WHERE is_revert"""

# Articles located at or linking the place at any moment during the year.
_ARTICLES_AT_PLACE = """(SELECT DISTINCT page_id, to_place AS place
       FROM place_link FOR SYSTEM_TIME FROM TIMESTAMP'{y0}' TO TIMESTAMP'{y1}'
       UNION
       SELECT page_id, place_title FROM page_place) x"""

METRICS = {
    "knowledge": [
        """INSERT INTO heat_year (year, place_title, knowledge)
SELECT {year}, to_place, COUNT(*)
FROM place_link FOR SYSTEM_TIME AS OF TIMESTAMP'{y0}'
GROUP BY to_place
ON DUPLICATE KEY UPDATE knowledge = VALUES(knowledge)""",
        """INSERT INTO heat_year (year, place_title, knowledge)
SELECT {year}, pp.place_title, ROUND(SUM(a.len) / 1000)
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP'{y0}' a
JOIN page_place pp ON pp.page_id = a.page_id
GROUP BY pp.place_title
ON DUPLICATE KEY UPDATE knowledge = COALESCE(knowledge, 0) + VALUES(knowledge)"""],
    "activity": [
        """INSERT INTO heat_year (year, place_title, activity)
SELECT {year}, x.place, COUNT(*)
FROM """ + _ARTICLES_AT_PLACE + """
JOIN article FOR SYSTEM_TIME ALL a
  ON a.page_id = x.page_id AND a.row_start >= '{y0}' AND a.row_start < '{y1}'
GROUP BY x.place
ON DUPLICATE KEY UPDATE activity = VALUES(activity)"""],
    "controversy": [
        """INSERT INTO heat_year (year, place_title, controversy)
SELECT {year}, x.place, COUNT(*)
FROM """ + _ARTICLES_AT_PLACE + """
JOIN revert r
  ON r.page_id = x.page_id AND r.row_start >= '{y0}' AND r.row_start < '{y1}'
GROUP BY x.place
ON DUPLICATE KEY UPDATE controversy = VALUES(controversy)"""],
    "rewritten": [
        """INSERT INTO heat_year (year, place_title, rewritten)
SELECT {year}, to_place,
       SUM(row_start >= '{y0}' AND row_start < '{y1}') + SUM(row_end >= '{y0}' AND row_end < '{y1}')
FROM place_link FOR SYSTEM_TIME ALL
WHERE (row_start >= '{y0}' AND row_start < '{y1}') OR (row_end >= '{y0}' AND row_end < '{y1}')
GROUP BY to_place
ON DUPLICATE KEY UPDATE rewritten = VALUES(rewritten)"""],
}


def for_year(sql, year):
    return sql.format(year=int(year), y0=f"{int(year)}-01-01 00:00:00",
                      y1=f"{int(year) + 1}-01-01 00:00:00")


# Where an article's arcs start, per year. Its own location (page_place) when it has one; otherwise
# inferred: the non-country place it linked most at any moment of the year (ties: the oldest link).
ORIGIN = [
    """INSERT INTO page_origin (year, page_id, place_title, inferred)
SELECT {year}, page_id, place_title, 0 FROM page_place""",
    """INSERT IGNORE INTO page_origin (year, page_id, place_title, inferred)
SELECT {year}, page_id, to_place, 1
FROM (SELECT l.page_id, l.to_place,
             ROW_NUMBER() OVER (PARTITION BY l.page_id
                                ORDER BY l.mentions DESC, l.row_start, l.to_place) AS rn
      FROM place_link FOR SYSTEM_TIME FROM TIMESTAMP'{y0}' TO TIMESTAMP'{y1}' l
      JOIN place p ON p.title = l.to_place
      WHERE p.is_country = 0) ranked
WHERE rn = 1""",
]


# The three kinds of arc for a year, straight from the system-versioned table.
ARC_EVENTS = """
  -- green: link added during the year
  SELECT page_id, to_place, 'added' AS status
  FROM place_link FOR SYSTEM_TIME ALL
  WHERE row_start >= TIMESTAMP'{y0}' AND row_start < TIMESTAMP'{y1}'
  UNION ALL
  -- red: link removed during the year
  SELECT page_id, to_place, 'removed'
  FROM place_link FOR SYSTEM_TIME ALL
  WHERE row_end >= TIMESTAMP'{y0}' AND row_end < TIMESTAMP'{y1}'
  UNION ALL
  -- grey: there on 1 Jan and still there (same row) at the end of the year
  SELECT page_id, to_place, 'same'
  FROM place_link FOR SYSTEM_TIME AS OF TIMESTAMP'{y1}'
  WHERE row_start < TIMESTAMP'{y0}'"""

# arc_year: the strongest arcs per year, status and origin type (rank 1 = most articles), so the
# globe never waits on a GROUP BY over every link. Built once per year from the SVT query above.
ARCS = """INSERT INTO arc_year (year, status, inferred, rnk, from_place, to_place, weight, articles)
SELECT {year}, status, inferred, rn, from_place, to_place, weight, articles
FROM (SELECT x.status, o.inferred, o.place_title AS from_place, x.to_place,
             COUNT(DISTINCT x.page_id) AS weight,
             GROUP_CONCAT(DISTINCT CONCAT(x.page_id, ':', a.title)
                          ORDER BY a.title SEPARATOR '|' LIMIT 8) AS articles,
             ROW_NUMBER() OVER (PARTITION BY x.status, o.inferred
                                ORDER BY COUNT(DISTINCT x.page_id) DESC, x.to_place, o.place_title) AS rn
      FROM (""" + ARC_EVENTS + """
      ) x
      JOIN page_origin o ON o.page_id = x.page_id AND o.year = {year}
      JOIN article a ON a.page_id = x.page_id
      WHERE o.place_title <> x.to_place
      GROUP BY x.status, o.inferred, o.place_title, x.to_place) ranked
WHERE rn <= {cap}"""

# Caption per year: totals, and the single edit that changed the most place links.
YEAR_TOTALS = """SELECT COALESCE(SUM(row_start >= '{y0}' AND row_start < '{y1}'), 0) AS added,
       COALESCE(SUM(row_end >= '{y0}' AND row_end < '{y1}'), 0) AS removed
FROM place_link FOR SYSTEM_TIME ALL
WHERE (row_start >= '{y0}' AND row_start < '{y1}') OR (row_end >= '{y0}' AND row_end < '{y1}')"""

BIGGEST_EDITS = """SELECT page_id, t, SUM(a) AS n_added, SUM(r) AS n_removed
FROM (SELECT page_id, row_start AS t, 1 AS a, 0 AS r FROM place_link FOR SYSTEM_TIME ALL
      WHERE row_start >= '{y0}' AND row_start < '{y1}'
      UNION ALL
      SELECT page_id, row_end, 0, 1 FROM place_link FOR SYSTEM_TIME ALL
      WHERE row_end >= '{y0}' AND row_end < '{y1}') e
GROUP BY page_id, t
ORDER BY SUM(a) + SUM(r) DESC, t
LIMIT 40"""
