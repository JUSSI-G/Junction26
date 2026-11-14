-- V4 without AI: how many sentences alive at the end of each period mention each term.
--
-- Sweep instead of periods x lives: every life is +1 in the period it starts and -1 in the period
-- it ends; a running SUM() OVER the periods gives the article's state at each period end.
-- One pass over FOR SYSTEM_TIME ALL, independent of the number of periods.
-- {months} (1 | 3 | 12) is filled in by the API from a whitelist;
-- {flag_columns} = ", LOCATE(%(term_0)s, CAST(LOWER(text) AS BINARY)) > 0 AS t_0, …"
-- {sum_columns}  = ", SUM(d * t_0) AS t_0, …"
-- {run_columns}  = ", SUM(COALESCE(delta.t_0, 0)) OVER w AS t_0, …"
WITH RECURSIVE base AS (
  -- first period: the calendar month / quarter / year of the first revision
  SELECT CAST(DATE_FORMAT(MIN(row_start), '%%Y-01-01') AS DATETIME)
         + INTERVAL ((MONTH(MIN(row_start)) - 1) DIV {months} * {months}) MONTH AS p0
  FROM article FOR SYSTEM_TIME ALL
  WHERE page_id = %(page_id)s
),
periods AS (
  SELECT 0 AS k
  UNION ALL
  SELECT k + 1 FROM periods, base WHERE p0 + INTERVAL ((k + 1) * {months}) MONTH <= NOW()
),
lives AS (
  SELECT row_start, row_end {flag_columns}
  FROM article_sentence FOR SYSTEM_TIME ALL
  WHERE page_id = %(page_id)s
),
events AS (
  SELECT TIMESTAMPDIFF(MONTH, base.p0, row_start) DIV {months} AS k, 1 AS d, lives.*
  FROM lives, base
  UNION ALL
  SELECT TIMESTAMPDIFF(MONTH, base.p0, row_end) DIV {months}, -1, lives.*
  FROM lives, base
  WHERE row_end < NOW()
),
delta AS (
  SELECT k, SUM(d) AS d {sum_columns} FROM events GROUP BY k
)
SELECT base.p0 + INTERVAL (periods.k * {months}) MONTH AS period_start,
       SUM(COALESCE(delta.d, 0)) OVER w AS sentences {run_columns}
FROM periods
CROSS JOIN base
LEFT JOIN delta ON delta.k = periods.k
WINDOW w AS (ORDER BY periods.k)
ORDER BY periods.k
