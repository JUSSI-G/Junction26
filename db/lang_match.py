r"""Stage 1, level 2: match every Finnish sentence to its nearest sv and en sentence (same topic),
calibrate the "no match" threshold on unrelated articles, and report what is missing.

    .venv\Scripts\python -m db.lang_match --topics Q29207,Q211855 > data\lang_match.txt

Needs lang_sentence filled for the topics and the null topics (ingest/embed_cpu.py --null N).
Writes lang_pair for the topics. Every distance is computed by MariaDB (VEC_DISTANCE_COSINE).

Threshold: for each Finnish sentence, its nearest sentence in UNRELATED articles of the other
language (random topics, a pool about as large as the real article) is a "best match by chance".
The threshold is the 5th percentile of those chance distances: a match closer than that happens
by chance for only 5 % of Finnish sentences. A sentence whose best match in its own topic is not
closer than the threshold is "missing" in that language.
"""
from __future__ import annotations

import argparse
import re
import sys
import time

import numpy as np

from common.db import connect

CHANCE_PERCENTILE = 5
NAMES = {"Q29207": "Sauli Niinistö", "Q211855": "Suomen sisällissota"}

# Best match of every sentence of one side, exact (all pairs within the topic). Shown in the report.
PAIR_SQL = """
INSERT INTO lang_pair (wikidata_id, other_lang, direction, fi_sent, other_sent, distance)
SELECT %(q)s, %(lang)s, %(direction)s, fi_sent, other_sent, distance
FROM (SELECT f.sent_no AS fi_sent, o.sent_no AS other_sent,
             VEC_DISTANCE_COSINE(f.embedding, o.embedding) AS distance,
             ROW_NUMBER() OVER (PARTITION BY {side}.sent_no
                                ORDER BY VEC_DISTANCE_COSINE(f.embedding, o.embedding)) AS rn
      FROM lang_sentence f
      JOIN lang_sentence o ON o.wikidata_id = f.wikidata_id AND o.lang = %(lang)s
      WHERE f.wikidata_id = %(q)s AND f.lang = 'fi') best
WHERE rn = 1"""

# Nearest sentence among unrelated articles (the null pool), for every Finnish sentence.
CHANCE_SQL = """
SELECT f.sent_no, MIN(VEC_DISTANCE_COSINE(f.embedding, o.embedding)) AS distance
FROM lang_sentence f
JOIN lang_sentence o ON o.lang = %(lang)s AND o.wikidata_id IN ({pool})
WHERE f.wikidata_id = %(q)s AND f.lang = 'fi'
GROUP BY f.sent_no"""

_NUM_SEP = re.compile(r"(?<=\d)[\s  ,](?=\d{3}\b)")      # 80 000 / 80,000 -> 80000
_NUM = re.compile(r"\d+(?:[.,]\d+)?")


_FOOTNOTE = re.compile(r"\[\d+\]")                                     # [130]: a reference, not a number


def numbers(text: str) -> set[str]:
    t = _NUM_SEP.sub("", _FOOTNOTE.sub("", text))
    return {n.replace(",", ".") for n in _NUM.findall(t)}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--topics", default="Q29207,Q211855")
    a = ap.parse_args()
    heroes = a.topics.split(",")
    con = connect()
    cur = con.cursor()
    cur.execute("SELECT wikidata_id, lang, COUNT(*) AS n FROM lang_sentence GROUP BY wikidata_id, lang")
    count = {(r["wikidata_id"], r["lang"]): r["n"] for r in cur.fetchall()}
    nulls = sorted({q for q, _ in count} - set(heroes))
    print(f"null topics (unrelated, random): {len(nulls)}: {', '.join(nulls)}\n")

    # 1. best matches, both directions
    t = time.perf_counter()
    for q in heroes:
        cur.execute("DELETE FROM lang_pair WHERE wikidata_id = %s", (q,))
        for lang in ("sv", "en"):
            for direction, side in (("fi", "f"), ("other", "o")):
                cur.execute(PAIR_SQL.format(side=side), dict(q=q, lang=lang, direction=direction))
    print(f"lang_pair written in {(time.perf_counter() - t) * 1000:.0f} ms:\n"
          + PAIR_SQL.format(side="f").replace("%(q)s", "'Q29207'").replace("%(lang)s", "'en'")
          .replace("%(direction)s", "'fi'").strip() + "\n")

    # 2. chance distances -> threshold
    chance, real = {}, {}
    rng = np.random.default_rng(1918)
    for q in heroes:
        for lang in ("sv", "en"):
            target = count[(q, lang)]
            pool, n = [], 0
            for nq in rng.permutation(nulls):                  # unrelated topics until the pool is as big
                if count.get((nq, lang)):
                    pool.append(str(nq))
                    n += count[(nq, lang)]
                if n >= target:
                    break
            cur.execute(CHANCE_SQL.format(pool=",".join(f"'{p}'" for p in pool)), dict(q=q, lang=lang))
            chance[(q, lang)] = np.array([float(r["distance"]) for r in cur.fetchall()])
            cur.execute("SELECT fi_sent, distance FROM lang_pair WHERE wikidata_id = %s AND other_lang = %s "
                        "AND direction = 'fi'", (q, lang))
            real[(q, lang)] = np.array([float(r["distance"]) for r in cur.fetchall()])
            print(f"{NAMES.get(q, q)} fi->{lang}: real article {target} sentences, chance pool {n} "
                  f"sentences from {len(pool)} unrelated articles")
    all_chance = np.concatenate(list(chance.values()))
    per_lang = {lang: np.percentile(np.concatenate([v for (q, l), v in chance.items() if l == lang]),
                                    CHANCE_PERCENTILE) for lang in ("sv", "en")}
    threshold = float(np.percentile(all_chance, CHANCE_PERCENTILE))
    print("\nbest-match distance, real topic vs chance (percentiles 5 / 25 / 50 / 75 / 95):")
    for k in real:
        print(f"  {NAMES.get(k[0], k[0])[:20]:<20} fi->{k[1]}  real   "
              + " / ".join(f"{x:.3f}" for x in np.percentile(real[k], [5, 25, 50, 75, 95])))
        print(f"  {'':<20}         chance "
              + " / ".join(f"{x:.3f}" for x in np.percentile(chance[k], [5, 25, 50, 75, 95])))
    print(f"\nTHRESHOLD = {threshold:.3f} (the {CHANCE_PERCENTILE}th percentile of all chance distances; "
          f"per language: sv {per_lang['sv']:.3f}, en {per_lang['en']:.3f}). distance < threshold = match.")

    # 3. counts
    print("\n| topic | lang | fi sentences | matched | missing in lang | lang sentences | only in lang |")
    print("|---|---|---|---|---|---|---|")
    for q in heroes:
        for lang in ("sv", "en"):
            cur.execute("""SELECT direction, COUNT(*) AS n, SUM(distance < %s) AS matched FROM lang_pair
                           WHERE wikidata_id = %s AND other_lang = %s GROUP BY direction""", (threshold, q, lang))
            d = {r["direction"]: r for r in cur.fetchall()}
            f, o = d["fi"], d["other"]
            print(f"| {NAMES.get(q, q)} | {lang} | {f['n']} | {int(f['matched'])} | **{f['n'] - int(f['matched'])}** "
                  f"| {o['n']} | {o['n'] - int(o['matched'])} |")

    # 4. clearest "missing in English": longest-distance fi sentences with >= 8 words
    MISSING_SQL = """
SELECT p.wikidata_id, f.sent_no, f.text AS fi_text, p.distance, o.text AS nearest_en,
       sv.distance AS sv_distance
FROM lang_pair p
JOIN lang_sentence f ON f.lang = 'fi' AND f.wikidata_id = p.wikidata_id AND f.sent_no = p.fi_sent
JOIN lang_topic t ON t.wikidata_id = p.wikidata_id
JOIN lang_sentence o ON o.lang = 'en' AND o.page_id = t.en_page_id AND o.sent_no = p.other_sent
LEFT JOIN lang_pair sv ON sv.wikidata_id = p.wikidata_id AND sv.other_lang = 'sv'
     AND sv.direction = 'fi' AND sv.fi_sent = p.fi_sent
WHERE p.other_lang = 'en' AND p.direction = 'fi' AND p.distance >= %(th)s
  AND p.wikidata_id IN ({heroes})
  AND LENGTH(f.text) - LENGTH(REPLACE(f.text, ' ', '')) >= 7
ORDER BY p.distance DESC"""
    sql = MISSING_SQL.format(heroes=",".join(f"'{q}'" for q in heroes))
    cur.execute(sql, dict(th=threshold))
    missing = cur.fetchall()
    print(f"\n=== missing in English: {len(missing)} Finnish sentences of 8+ words with no English match\n{sql.strip()}\n")
    for r in missing[:12]:
        sv = f"{float(r['sv_distance']):.3f}" if r["sv_distance"] is not None else "-"
        print(f"[{NAMES.get(r['wikidata_id'])} fi#{r['sent_no']}] en distance {float(r['distance']):.3f}, "
              f"sv distance {sv}\n  FI: {r['fi_text']}\n  nearest EN: {r['nearest_en']}\n")

    # 5. matched pairs whose numbers differ
    cur.execute("""
SELECT p.wikidata_id, p.other_lang, p.fi_sent, p.other_sent, p.distance, f.text AS fi_text, o.text AS other_text
FROM lang_pair p
JOIN lang_topic t ON t.wikidata_id = p.wikidata_id
JOIN lang_sentence f ON f.lang = 'fi' AND f.page_id = t.fi_page_id AND f.sent_no = p.fi_sent
JOIN lang_sentence o ON o.lang = p.other_lang
     AND o.page_id = IF(p.other_lang = 'sv', t.sv_page_id, t.en_page_id) AND o.sent_no = p.other_sent
WHERE p.direction = 'fi' AND p.distance < %s""", (threshold,))
    pairs = cur.fetchall()
    diff = []
    for r in pairs:
        nf, no = numbers(r["fi_text"]), numbers(r["other_text"])
        if nf and no and nf != no:
            diff.append((r, sorted(nf - no), sorted(no - nf), len(nf & no)))
    both = [d for d in diff if d[1] and d[2]]       # each side has a number the other lacks
    print(f"=== matched pairs whose numbers differ: {len(diff)} of {len(pairs)} matched pairs "
          f"({sum(1 for r in pairs if numbers(r['fi_text']) and numbers(r['other_text']))} pairs where both "
          f"sentences contain numbers); {len(both)} where EACH side has a number the other lacks\n")
    diff = both
    diff.sort(key=lambda x: (-x[3], float(x[0]["distance"])))       # most shared numbers first: same claim
    for r, only_fi, only_other, shared in diff[:15]:
        print(f"[{NAMES.get(r['wikidata_id'])} fi#{r['fi_sent']} ~ {r['other_lang']}#{r['other_sent']}] "
              f"distance {float(r['distance']):.3f}, shared numbers {shared}, only fi {only_fi}, "
              f"only {r['other_lang']} {only_other}\n  FI: {r['fi_text']}\n  {r['other_lang'].upper()}: "
              f"{r['other_text']}\n")
    con.commit()
    con.close()


if __name__ == "__main__":
    main()
