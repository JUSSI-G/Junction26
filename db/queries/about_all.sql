-- BITEMPORAL, all of Wikipedia: everything the encyclopedia said at %(ts)s (system time) about
-- events between %(from)s and %(to)s (application time), grouped by article.
-- Starts from the application-time index (event_time_key), then checks system time per sentence.
SELECT s.page_id, a.title, COUNT(*) AS sentences,
       SUBSTRING_INDEX(GROUP_CONCAT(s.text ORDER BY e.event_to - e.event_from, s.position SEPARATOR '\n'), '\n', 3) AS sample
FROM sentence_event_time e
JOIN article_sentence FOR SYSTEM_TIME AS OF TIMESTAMP %(ts)s s ON s.sent_hash = e.sent_hash
JOIN article a ON a.page_id = s.page_id
WHERE e.event_from < %(to)s AND e.event_to > %(from)s
GROUP BY s.page_id, a.title
ORDER BY sentences DESC
LIMIT %(limit)s
