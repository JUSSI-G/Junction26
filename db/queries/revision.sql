-- One revision by Wikipedia rev_id (history rows included).
SELECT rev_id, page_id, title, row_start AS ts, row_end AS ts_end, editor, anonymous, comment,
       minor, n_sentences
FROM article FOR SYSTEM_TIME ALL
WHERE rev_id = %(rev_id)s
