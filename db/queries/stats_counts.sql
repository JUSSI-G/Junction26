-- Dataset size for /stats and the numbers slide, summed from article_stats (one row per
-- article) instead of counting 862k revisions and 1.4M sentence lives on every request.
-- distinct_sentences is per article, summed (a sentence shared by two articles counts twice).
SELECT COUNT(*)                     AS articles,
       SUM(revisions)               AS revisions,
       SUM(lives)                   AS sentence_rows,
       SUM(n_sentences)             AS current_sentences,
       SUM(distinct_sentences)      AS distinct_sentences,
       (SELECT COUNT(*) FROM sentence_score) AS scored_sentences
FROM article_stats
