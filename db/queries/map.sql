-- The globe: every placed article with how contested its history is, from article_stats
-- (written at load time), so this is a plain join instead of an aggregation over all history.
--   returns  : sentence lives beyond the first (a sentence removed and put back): edit-war signal
--   reverts  : whole-article reverts (wikitext identical to an earlier version, not the previous one)
--   churn    : sentence lives per current sentence: how much the text has been rewritten
-- LEFT JOIN: an article whose summary isn't computed yet (python -m ingest.stats) still shows, as calm.
SELECT g.page_id, a.title, g.lat, g.lon, g.source, COALESCE(o.n_sentences, a.n_sentences) AS n_sentences,
       COALESCE(st.revisions, 1) AS revisions, COALESCE(st.reverts, 0) AS reverts,
       COALESCE(st.lives - st.distinct_sentences, 0) AS returns,
       COALESCE(st.lives, COALESCE(o.n_sentences, a.n_sentences))
         / GREATEST(COALESCE(o.n_sentences, a.n_sentences), 1) AS churn,
       COALESCE(st.first_rev, a.row_start) AS first_rev, a.row_start AS last_rev
FROM article_geo g
JOIN article a ON a.page_id = g.page_id
LEFT JOIN article_stats st ON st.page_id = g.page_id
LEFT JOIN article_sentence_order o ON o.rev_id = a.rev_id
