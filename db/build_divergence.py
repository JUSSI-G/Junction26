r"""Build article_divergence: the editor worklist, one row per topic in fi + sv + en (2,919).

    .venv\Scripts\python -m db.build_divergence

Parts (each 0..1, higher = needs an editor more), from MariaDB:
  divergence  mean of PERCENT_RANK(fi_sv) and PERCENT_RANK(fi_en): whole-article VEC_DISTANCE_COSINE
              between dataset S's bge-m3 vectors (length differences included: missing text is
              exactly what an editor should see)
  edit_war    PERCENT_RANK of (sentence lives that came back + whole-article reverts) of the Finnish
              article, from article_stats (built from article_sentence FOR SYSTEM_TIME ALL)
  missing     share of Finnish sentences without a matched sv / en sentence (lang_pair), where
              sentence data exists
score = 0.6 · divergence + 0.4 · edit_war (missing has weight 0 until every topic has sentence data).

"Different subject": the same Wikidata id, but the language versions are about different things
(Renki = a Finnish farmhand vs Farmworker; Kirvu = a former Finnish municipality vs a Russian village).
Flagged when the whole-article distance is extreme (above the 97th percentile for fi–sv or fi–en)
AND fewer than SUBJECT_SHARE of the shorter version's sentences have a matched sentence in the other,
when that shorter version has at least MIN_SENTENCES sentences. (A stub is not a different subject:
the 4-sentence Swedish *Röda gardet (Finland)* matches none of the 474 sentences of *Punakaarti*.)
Flagged topics get no rank and are left out of the main worklist.
"""
from __future__ import annotations

import sys
import time

import numpy as np

from common.db import connect
from db.lang_distance import SQL as DISTANCE_SQL

EXTREME_PERCENTILE = 97
SUBJECT_SHARE = 0.10
MIN_SENTENCES = 5
# The score uses only parts every topic has. "missing" (sentence matching) exists for a few hundred
# topics; mixing it in ranked exactly those topics first. Until every topic has sentence data (stage 2,
# Verda) it is shown in the worklist but left out of the score: weight 0.
WEIGHTS = {"divergence": 0.6, "edit_war": 0.4, "missing": 0.0}

DDL = [
    """CREATE TABLE IF NOT EXISTS article_divergence (
  wikidata_id        VARCHAR(20) NOT NULL PRIMARY KEY,
  fi_page_id         INT UNSIGNED NOT NULL,
  fi_sv              FLOAT, fi_en FLOAT, sv_en FLOAT,       -- whole-article cosine distance
  has_sentences      BOOL NOT NULL DEFAULT 0,
  fi_sentences       INT, missing_sv INT, missing_en INT,   -- NULL: sentences not computed
  share_sv           FLOAT, share_en FLOAT,                 -- matched / shorter version's sentences
  contradictions     INT,                                   -- NULL: Gemma has not judged this topic
  edit_war_score     FLOAT,                                 -- NULL: Finnish article not in dataset M
  different_subject  BOOL NOT NULL DEFAULT 0,
  subject_note       VARCHAR(255),
  score              FLOAT,
  rnk                INT,
  KEY (rnk)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci""",
    # Gemma's judgements (docs/contracts.md b), imported from data/verda/judgements.parquet.
    """CREATE TABLE IF NOT EXISTS pair_judgement (
  wikidata_id    VARCHAR(20) NOT NULL,
  fi_sent_no     INT UNSIGNED NOT NULL,
  other_lang     CHAR(2) NOT NULL,
  other_sent_no  INT UNSIGNED NOT NULL,
  label          ENUM('same', 'contradiction', 'framing', 'partial') NOT NULL,
  reason         TEXT,
  tone_fi        ENUM('neutral', 'loaded', 'partisan'),
  tone_other     ENUM('neutral', 'loaded', 'partisan'),
  model          VARCHAR(100) NOT NULL,
  PRIMARY KEY (wikidata_id, other_lang, fi_sent_no, other_sent_no, model)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci""",
]

SENTENCE_SQL = """
SELECT p.wikidata_id, p.other_lang, p.direction, COUNT(*) AS n, SUM(p.matched) AS matched
FROM lang_pair p
GROUP BY p.wikidata_id, p.other_lang, p.direction"""

EDIT_WAR_SQL = """
SELECT t.wikidata_id,
       PERCENT_RANK() OVER (ORDER BY (s.lives - s.distinct_sentences) + s.reverts) AS edit_war_score
FROM lang_topic t
JOIN article_stats s ON s.page_id = t.fi_page_id"""

CONTRADICTIONS_SQL = """
SELECT wikidata_id, SUM(label = 'contradiction') AS contradictions
FROM pair_judgement GROUP BY wikidata_id"""


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    t0 = time.time()
    con = connect(autocommit=True)
    cur = con.cursor()
    for ddl in DDL:
        cur.execute(ddl)
    cur.execute(DISTANCE_SQL)
    topics = {r["wikidata_id"]: r for r in cur.fetchall()}
    cur.execute("SELECT wikidata_id, fi_page_id FROM lang_topic")
    page = {r["wikidata_id"]: r["fi_page_id"] for r in cur.fetchall()}
    cur.execute(SENTENCE_SQL)
    sent: dict = {}
    for r in cur.fetchall():
        sent.setdefault(r["wikidata_id"], {})[(r["other_lang"], r["direction"])] = (int(r["n"]), int(r["matched"]))
    cur.execute(EDIT_WAR_SQL)
    war = {r["wikidata_id"]: float(r["edit_war_score"]) for r in cur.fetchall()}
    cur.execute(CONTRADICTIONS_SQL)
    contra = {r["wikidata_id"]: int(r["contradictions"]) for r in cur.fetchall()}

    ids = sorted(topics)
    d = {p: np.array([float(topics[q][p]) for q in ids]) for p in ("fi_sv", "fi_en", "sv_en")}
    pr = {p: (d[p].argsort().argsort() / (len(ids) - 1)) for p in ("fi_sv", "fi_en")}   # percent rank
    cut = {p: np.percentile(d[p], EXTREME_PERCENTILE) for p in ("fi_sv", "fi_en")}

    rows, flagged = [], []
    for i, q in enumerate(ids):
        s = sent.get(q)
        has = bool(s and all(k in s for k in (("sv", "fi"), ("en", "fi"), ("sv", "other"), ("en", "other"))))
        fi_n = miss_sv = miss_en = share_sv = share_en = None
        if has:
            fi_n = s[("sv", "fi")][0]
            miss_sv = fi_n - s[("sv", "fi")][1]
            miss_en = fi_n - s[("en", "fi")][1]
            short_sv, short_en = min(fi_n, s[("sv", "other")][0]), min(fi_n, s[("en", "other")][0])
            share_sv = s[("sv", "fi")][1] / max(1, short_sv)
            share_en = s[("en", "fi")][1] / max(1, short_en)
        parts = {"divergence": (pr["fi_sv"][i] + pr["fi_en"][i]) / 2, "edit_war": war.get(q),
                 "missing": (miss_sv / fi_n + miss_en / fi_n) / 2 if has and fi_n else None}
        avail = {k: v for k, v in parts.items() if v is not None and WEIGHTS[k] > 0}
        score = sum(WEIGHTS[k] * v for k, v in avail.items()) / sum(WEIGHTS[k] for k in avail)
        different, note = False, None
        for pair, share, short in (("fi_sv", share_sv, short_sv if has else 0),
                                   ("fi_en", share_en, short_en if has else 0)):
            if d[pair][i] > cut[pair] and share is not None and share < SUBJECT_SHARE and short >= MIN_SENTENCES:
                different = True
                note = (f"{pair.replace('_', '–')} distance {d[pair][i]:.3f} (> p{EXTREME_PERCENTILE} "
                        f"{cut[pair]:.3f}) and only {share:.0%} of the shorter version's sentences match")
                break
        if different:
            flagged.append(q)
        rows.append([q, page[q], float(d["fi_sv"][i]), float(d["fi_en"][i]), float(d["sv_en"][i]), has,
                     fi_n, miss_sv, miss_en, share_sv, share_en, contra.get(q), war.get(q), different, note,
                     round(float(score), 4), None])
    ranked = sorted((r for r in rows if not r[13]), key=lambda r: -r[15])
    for k, r in enumerate(ranked, 1):
        r[16] = k
    cur.execute("DELETE FROM article_divergence")
    cur.executemany("INSERT INTO article_divergence VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    [tuple(r) for r in rows])
    print(f"article_divergence: {len(rows):,} topics, {sum(1 for r in rows if r[5])} with sentence data, "
          f"{sum(1 for r in rows if r[12] is not None):,} with an edit-war score, "
          f"{len(flagged)} flagged as different subject ({time.time() - t0:.1f} s)")
    print(f"extreme cut: fi_sv > {cut['fi_sv']:.3f}, fi_en > {cut['fi_en']:.3f}; "
          f"{sum(1 for i in range(len(ids)) if d['fi_sv'][i] > cut['fi_sv'] or d['fi_en'][i] > cut['fi_en'])} extreme topics")
    con.close()


if __name__ == "__main__":
    main()
