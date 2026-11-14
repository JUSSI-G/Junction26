-- Articles near a clicked point: SPATIAL INDEX range (MBRContains on a box of +/- %(deg)s degrees),
-- then exact great-circle distance with ST_Distance_Sphere (metres).
SELECT g.page_id, a.title, g.lat, g.lon, g.source,
       ROUND(ST_Distance_Sphere(g.pt, POINT(%(lon)s, %(lat)s)) / 1000, 1) AS km
FROM article_geo g
JOIN article a ON a.page_id = g.page_id
WHERE MBRContains(
        ST_GeomFromText(CONCAT('POLYGON((',
          %(lon)s - %(deg)s, ' ', %(lat)s - %(deg)s, ',', %(lon)s + %(deg)s, ' ', %(lat)s - %(deg)s, ',',
          %(lon)s + %(deg)s, ' ', %(lat)s + %(deg)s, ',', %(lon)s - %(deg)s, ' ', %(lat)s + %(deg)s, ',',
          %(lon)s - %(deg)s, ' ', %(lat)s - %(deg)s, '))')),
        g.pt)
ORDER BY km
LIMIT %(limit)s
