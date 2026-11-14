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
