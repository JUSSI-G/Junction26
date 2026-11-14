-- Every revision of an article (timeline ticks for the slider), oldest first, with reverts:
-- a revision whose wikitext (sha1) equals an earlier one but not the one just before it.
SELECT rev_id, row_start AS ts, editor, anonymous, comment, minor, n_sentences,
       COALESCE(sha1 <> LAG(sha1) OVER (ORDER BY row_start)
                AND MIN(row_start) OVER (PARTITION BY sha1) < row_start, 0) AS is_revert
FROM article FOR SYSTEM_TIME ALL
WHERE page_id = %(page_id)s
ORDER BY row_start
