-- Which model produced the scores (Gemma vs the keyword baseline), for honest labelling in the UI.
SELECT model, COUNT(*) AS n FROM sentence_score GROUP BY model ORDER BY n DESC
