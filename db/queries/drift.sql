-- V4: the article at the end of every period, as Gemma scored it: sentences alive then, grouped
-- by the name they use for the event, with their average neutrality and loaded/partisan counts.
--
-- Same sweep as term_drift.sql: +1 when a life starts, -1 when it ends, running SUM() OVER the
-- periods per event name. One pass over FOR SYSTEM_TIME ALL.
-- {months} (1 | 3 | 12) is filled in by the API from a whitelist.
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
  SELECT s.row_start, s.row_end, COALESCE(sc.event_name, '') AS ev, sc.neutrality,
         sc.tone = 'loaded' AS is_loaded, sc.tone = 'partisan' AS is_partisan
  FROM article_sentence FOR SYSTEM_TIME ALL s
  JOIN sentence_score sc ON sc.sent_hash = s.sent_hash
  WHERE s.page_id = %(page_id)s
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
  SELECT k, ev, SUM(d) AS n, SUM(d * neutrality) AS neu,
         SUM(d * is_loaded) AS loaded, SUM(d * is_partisan) AS partisan
  FROM events
  GROUP BY k, ev
),
names AS (SELECT DISTINCT ev FROM delta),
running AS (
  SELECT periods.k, names.ev,
         SUM(COALESCE(delta.n, 0))        OVER w AS n,
         SUM(COALESCE(delta.neu, 0))      OVER w AS neu,
         SUM(COALESCE(delta.loaded, 0))   OVER w AS loaded,
         SUM(COALESCE(delta.partisan, 0)) OVER w AS partisan
  FROM periods
  CROSS JOIN names
  LEFT JOIN delta ON delta.k = periods.k AND delta.ev = names.ev
  WINDOW w AS (PARTITION BY names.ev ORDER BY periods.k)
)
SELECT base.p0 + INTERVAL (running.k * {months}) MONTH AS period_start,
       NULLIF(running.ev, '') AS event_name, running.n,
       running.neu / running.n AS avg_neutrality, running.loaded, running.partisan
FROM running
CROSS JOIN base
WHERE running.n > 0
ORDER BY running.k, running.ev
