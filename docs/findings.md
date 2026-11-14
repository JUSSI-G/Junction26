# Findings: Finnish Wikipedia's history articles, 2003–2026

All 19,742 articles in dataset M, 862,076 versions, loaded into MariaDB system-versioned tables with
Wikipedia's real save times. Every number below comes from the SQL shown under it.
`findings.py` and `findings_extra.py` rerun them; the raw output is in `data/findings_raw.txt` and
`data/findings_extra.txt`.

Terms used:
- **Place link:** an article links to a place with coordinates (a row in `place_link`, which lives from
  the first version containing the link to the first version without it).
- **Revert:** a version whose text is identical to an earlier version but not to the one just before
  it (same `sha1`).
- Versions undone by a revert within 48 hours are left out of `place_link` (noise filter: 52,919
  versions, 6.1 %).

---

## 1. Helsinki is the most rewritten place

Links to Helsinki were added 4,426 times and removed 392 times: **4,818 changes**, more than twice
any other city.

| place | kind | added | removed | changes |
|---|---|---|---|---|
| **Helsinki** | city | 4,426 | 392 | **4,818** |
| Turku | big city | 1,766 | 209 | 1,975 |
| Pietari (St Petersburg) | federal city of Russia | 1,586 | 140 | 1,726 |
| Tampere | big city | 1,382 | 174 | 1,556 |
| Viipuri (Vyborg) | city or town | 1,339 | 112 | 1,451 |
| Oulu | city | 1,029 | 121 | 1,150 |
| Vaasa | city | 744 | 84 | 828 |
| Tukholma (Stockholm) | city | 718 | 66 | 784 |
| Kuopio | city | 673 | 84 | 757 |
| Pori | city | 663 | 82 | 745 |

```sql
SELECT l.to_place, p.kind, COUNT(*) AS added, SUM(l.row_end < NOW()) AS removed,
       COUNT(*) + SUM(l.row_end < NOW()) AS changes
FROM place_link FOR SYSTEM_TIME ALL l
JOIN place p ON p.title = l.to_place
WHERE p.is_country = 0
GROUP BY l.to_place, p.kind ORDER BY changes DESC LIMIT 10;
```

Footnote: counting countries too, **Suomi** (Finland) leads with 4,992 added and 1,282 removed
(6,274 changes): 26 % of its links were later removed, against 9 % for Helsinki.
Same query without `WHERE p.is_country = 0`. Of places linked at least 150 times, Karjala (Karelia)
lost the largest share: 161 of 379 (42 %).

---

## 2. 2007 was the busiest year, because that is when most of the articles were written

2007 had the most place links added (11,276) and removed (1,559). It is also the peak year for
versions saved, new articles and reverts. **5,039 of the 11,276 links (45 %) came from the first
version of a new article.**

| year | links added | of which in a new article | links removed | versions saved | articles created | reverts |
|---|---|---|---|---|---|---|
| 2005 | 6,726 | 2,835 | 454 | 22,794 | 1,487 | 835 |
| 2006 | 8,710 | 2,906 | 1,114 | 50,130 | 1,542 | 2,418 |
| **2007** | **11,276** | **5,039** | **1,559** | **70,759** | **2,080** | **3,701** |
| 2008 | 9,962 | 4,723 | 1,459 | 61,652 | 1,649 | 3,433 |
| 2009 | 8,234 | 4,007 | 1,434 | 55,515 | 1,324 | 2,679 |

The single edit that changed the most place links in 2007: *Kesäolympialaiset 1952*, 60 links added
("osanottajamaat siirretty tänne", participating countries moved here).

```sql
-- links added / removed per year
SELECT y, SUM(added) AS added, SUM(removed) AS removed FROM (
  SELECT YEAR(row_start) AS y, COUNT(*) AS added, 0 AS removed
  FROM place_link FOR SYSTEM_TIME ALL GROUP BY y
  UNION ALL
  SELECT YEAR(row_end), 0, COUNT(*)
  FROM place_link FOR SYSTEM_TIME ALL WHERE row_end < NOW() GROUP BY 1) t
GROUP BY y ORDER BY y;

-- of which added by an article's first version
SELECT YEAR(l.row_start) AS y, COUNT(*) AS added_in_new_article
FROM place_link FOR SYSTEM_TIME ALL l
JOIN (SELECT page_id, MIN(row_start) AS first FROM article FOR SYSTEM_TIME ALL GROUP BY page_id) f
  ON f.page_id = l.page_id AND l.row_start = f.first
GROUP BY y ORDER BY y;

-- versions saved and articles created per year
SELECT YEAR(v.row_start) AS y, COUNT(*) AS versions_saved, SUM(v.row_start = f.first) AS articles_created
FROM article FOR SYSTEM_TIME ALL v
JOIN (SELECT page_id, MIN(row_start) AS first FROM article FOR SYSTEM_TIME ALL GROUP BY page_id) f
  ON f.page_id = v.page_id
GROUP BY y ORDER BY y;

-- reverts per year (the revert table is built from article FOR SYSTEM_TIME ALL, see heat_sql.REVERTS)
SELECT YEAR(row_start) AS y, COUNT(*) AS reverts FROM revert GROUP BY y ORDER BY y;
```

---

## 3. Tarja Halonen is the most reverted article

971 of her article's 3,078 versions are reverts. Next: Sauli Niinistö 627, Mikael Agricola 509,
Urho Kekkonen 477, Suomen tasavallan presidentti 372, Timo Soini 347, Suomen sisällissota 343,
Talvisota 328, C. G. E. Mannerheim 327.

Her worst year was 2006 (146 reverts), followed by 2008 (133) and 2007 (130).

**Around the 2006 presidential election** (first round 15 January, second round 29 January 2006):

| month | versions | reverts | revert share |
|---|---|---|---|
| 2005-11 | 43 | 5 | 12 % |
| 2005-12 | 46 | 13 | 28 % |
| **2006-01** | **141** | **36** | 26 % |
| 2006-02 | 49 | 14 | 29 % |
| 2006-03 | 25 | 7 | 28 % |
| 2006-04 | 17 | 6 | 35 % |
| 2006-05 | 32 | 12 | 38 % |
| 2006-06 | 20 | 4 | 20 % |
| 2006-07 | 19 | 7 | 37 % |
| 2006-08 | 35 | 15 | 43 % |
| 2006-09 | 23 | 7 | 30 % |
| 2006-10 | 23 | 11 | 48 % |
| 2006-11 | 32 | 13 | 41 % |
| 2006-12 | 36 | 14 | 39 % |
| 2007-01 | 82 | 30 | 37 % |
| 2007-02 | 46 | 16 | 35 % |
| 2007-03 | 52 | 18 | 35 % |

- **Yes, the spike lines up with the election:** January 2006 has the most edits (141) and the most
  reverts (36) of any month from July 2005 to June 2007.
- **But it is a spike in editing, not in fighting:** 26 % of that month's versions were reverts, about
  the same as the months around it. The revert *share* was higher later in 2006 (up to 48 % in
  October), and January 2007 (37 %, no election) had nearly as many reverts (30).
- Over all of 2006, 146 of 452 versions (32 %) were reverts.

```sql
-- most reverted articles
SELECT a.title, r.reverts,
       (SELECT COUNT(*) FROM article FOR SYSTEM_TIME ALL v WHERE v.page_id = r.page_id) AS versions
FROM (SELECT page_id, COUNT(*) AS reverts FROM revert GROUP BY page_id ORDER BY reverts DESC LIMIT 12) r
JOIN article a ON a.page_id = r.page_id
ORDER BY r.reverts DESC;

-- Halonen: versions and reverts per month
SELECT DATE_FORMAT(v.row_start, '%Y-%m') AS month, COUNT(*) AS versions, COUNT(r.rev_id) AS reverts
FROM article FOR SYSTEM_TIME ALL v
LEFT JOIN revert r ON r.page_id = v.page_id AND r.rev_id = v.rev_id
WHERE v.page_id = (SELECT page_id FROM article WHERE title = 'Tarja Halonen')
  AND v.row_start >= '2005-07-01' AND v.row_start < '2007-07-01'
GROUP BY month ORDER BY month;
```

---

## 4. Links moved from modern countries to the state of the period

The most common one-for-one link swap (an edit that removed exactly one place link and added exactly
one) is **Venäjä (Russia) → Venäjän keisarikunta (Russian Empire): 48 edits.**
Then Satakunnan maakunta → Satakunnan historiallinen maakunta 19, Saksa → Natsi-Saksa 18,
Novgorod → Novgorodin tasavalta 18, Saksa → Saksan keisarikunta 11, Saksa → Länsi-Saksa 10,
Venäjä → Neuvosto-Venäjä 8. Swaps the other way are rarer (Länsi-Saksa → Saksa 7, Natsi-Saksa → Saksa 5).

Articles linking each, as of 1 January:

| year | Venäjä | Venäjän keisarikunta | Saksa | Saksan keisarikunta | Natsi-Saksa |
|---|---|---|---|---|---|
| 2008 | 490 | 70 | 228 | 12 | 32 |
| 2014 | 1,039 | 204 | 292 | 48 | 164 |
| 2020 | 1,262 | 334 | 357 | 107 | 222 |
| 2026 | 1,435 | 515 | 400 | 148 | 271 |
| **growth 2008→2026** | **×2.9** | **×7.4** | **×1.8** | **×12.3** | **×8.5** |

Links to the historical states grew several times faster than links to the modern countries.
(Growth includes new articles, so this shows where new links went, not only rewrites. The 48 swaps
are the direct rewrites.)

```sql
-- one-for-one swaps
WITH removed AS (SELECT page_id, row_end AS t, MIN(to_place) AS place
                 FROM place_link FOR SYSTEM_TIME ALL WHERE row_end < NOW()
                 GROUP BY page_id, row_end HAVING COUNT(*) = 1),
     added AS (SELECT page_id, row_start AS t, MIN(to_place) AS place
               FROM place_link FOR SYSTEM_TIME ALL
               GROUP BY page_id, row_start HAVING COUNT(*) = 1)
SELECT removed.place AS link_removed, added.place AS link_added, COUNT(*) AS edits
FROM removed JOIN added ON added.page_id = removed.page_id AND added.t = removed.t
GROUP BY 1, 2 ORDER BY edits DESC LIMIT 25;

-- articles linking each place, run for every 1 January 2004–2026
SELECT to_place, COUNT(*)
FROM place_link FOR SYSTEM_TIME AS OF TIMESTAMP'2014-01-01 00:00:00'
WHERE to_place IN ('Venäjä', 'Venäjän keisarikunta', 'Neuvostoliitto',
                   'Saksa', 'Natsi-Saksa', 'Saksan keisarikunta')
GROUP BY to_place;
```

---

## 5. The 1918 war's name: no shift; "sisällissota" has led about 5–6 to 1 since 2009

Articles whose text contained each word on 1 January, as the articles stood that day.
**"Not the medal"** leaves out articles where "vapaussota" appears only in the name of the medal
*Vapaussodan muistomitali* (common in soldiers' biographies). Ratio = sisällissota ÷ vapaussota
(not the medal).

| 1 Jan | articles | vapaussota (any) | vapaussota (not the medal) | sisällissota | ratio |
|---|---|---|---|---|---|
| 2004 | 55 | 1 | 1 | 3 | 3.0 |
| 2005 | 706 | 7 | 7 | 30 | 4.3 |
| 2006 | 2,193 | 13 | 13 | 72 | 5.5 |
| 2007 | 3,735 | 43 | 43 | 183 | 4.3 |
| 2008 | 5,815 | 102 | 101 | 379 | 3.8 |
| 2009 | 7,464 | 444 | 165 | 860 | 5.2 |
| 2010 | 8,788 | 631 | 192 | 1,133 | 5.9 |
| 2011 | 9,612 | 699 | 207 | 1,232 | 6.0 |
| 2012 | 10,392 | 732 | 218 | 1,318 | 6.0 |
| 2013 | 11,137 | 744 | 227 | 1,361 | 6.0 |
| 2014 | 12,073 | 754 | 237 | 1,403 | 5.9 |
| 2015 | 12,930 | 769 | 249 | 1,523 | 6.1 |
| 2016 | 13,734 | 774 | 255 | 1,590 | 6.2 |
| 2017 | 14,681 | 806 | 287 | 1,700 | 5.9 |
| 2018 | 15,449 | 826 | 309 | 1,770 | 5.7 |
| 2019 | 15,965 | 851 | 334 | 1,839 | 5.5 |
| 2020 | 16,508 | 865 | 347 | 1,884 | 5.4 |
| 2021 | 17,188 | 885 | 367 | 1,961 | 5.3 |
| 2022 | 17,860 | 894 | 375 | 2,020 | 5.4 |
| 2023 | 18,426 | 925 | 407 | 2,096 | 5.1 |
| 2024 | 18,853 | 933 | 416 | 2,148 | 5.2 |
| 2025 | 19,248 | 940 | 423 | 2,235 | 5.3 |
| 2026 | 19,550 | 950 | 433 | 2,308 | 5.3 |

What the data shows:
- **There is no naming shift.** "Sisällissota" was already ahead in 2004 (3 to 1) and has led by
  about 5–6 to 1 every year since 2009. Neither word took over from the other.
- **The 2008→2009 jump in "vapaussota" (102 → 444) is the medal**, not the war: in 2009, 279 of the
  444 articles used the word only in the medal's name.
- **A small drift the other way since 2016:** the ratio fell from 6.2 to 5.1–5.3, because
  "vapaussota" (not the medal) grew faster (255 → 433, +70 %) than "sisällissota" (1,590 → 2,308,
  +45 %). Too small to call a shift.
- **Caveats:** this counts articles containing a word, not how each article names the war.
  "Sisällissota" also covers other countries' civil wars (Spanish, Russian, American), so it
  overstates the Finnish war. "Vapaussota" can be a quotation or a name (e.g. a veterans'
  association). A stricter count would need the words in context.

```sql
-- run for every 1 January 2004–2026
SELECT COUNT(*) AS articles,
       SUM(text LIKE '%vapausso%') AS vapaussota_all,
       SUM(REPLACE(REPLACE(text, 'Vapaussodan muistomital', ''), 'vapaussodan muistomital', '')
           LIKE '%vapausso%') AS vapaussota_not_medal,
       SUM(text LIKE '%sisällisso%') AS sisallissota
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP'2014-01-01 00:00:00';
```
About 26 s per year: each run reads the full text of every article as it stood that day.
