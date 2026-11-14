-- One revision by Wikipedia rev_id (history rows included).
SELECT a.rev_id, a.page_id, a.title, a.row_start AS ts, a.row_end AS ts_end, a.editor, a.anonymous,
       a.comment, a.minor, COALESCE(o.n_sentences, a.n_sentences) AS n_sentences
FROM article FOR SYSTEM_TIME ALL a
LEFT JOIN article_sentence_order o ON o.rev_id = a.rev_id
WHERE a.rev_id = %(rev_id)s
