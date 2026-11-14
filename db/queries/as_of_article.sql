-- V1: the article (revision metadata + sentence order) as it stood at %(ts)s.
-- The row_start/ORDER BY/LIMIT part is logically redundant with AS OF; it lets the optimizer
-- use start_key and read one version instead of walking the row_end-ordered history index.
SELECT page_id, title, rev_id, editor, anonymous, comment, n_sentences, sentence_order,
       row_start AS ts
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP %(ts)s
WHERE page_id = %(page_id)s AND row_start <= %(ts)s
ORDER BY row_start DESC
LIMIT 1
