"""The editor tool's routes: the worklist and the fi / sv / en comparison. Format: docs/contracts.md (c).

GET /api/worklist?limit=50&include_flagged=0   topics ranked by how much an editor is needed
GET /api/compare/{wikidata_id}                  fi / sv / en side by side, sentence by sentence

Both answers carry `sql`: the MariaDB queries behind them (vector distances, sentence matches).
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from api.places import query, render
from db.lang_match import THRESHOLD

router = APIRouter(tags=["editor"])
LANGS = ("fi", "sv", "en")


def _num(v, nd=3):
    return None if v is None else round(float(v), nd)


WORKLIST_SQL = """SELECT d.wikidata_id, fi.title AS title_fi, sv.title AS title_sv, en.title AS title_en,
       d.fi_page_id, d.score, d.fi_sv, d.fi_en, d.missing_sv, d.missing_en,
       d.missing_in_fi_sv, d.missing_in_fi_en, d.contradictions, d.edit_war_score
FROM article_divergence d
JOIN lang_topic t USING (wikidata_id)
JOIN lang_article fi ON fi.lang = 'fi' AND fi.page_id = t.fi_page_id
JOIN lang_article sv ON sv.lang = 'sv' AND sv.page_id = t.sv_page_id
JOIN lang_article en ON en.lang = 'en' AND en.page_id = t.en_page_id
{where}
ORDER BY d.different_subject, d.score DESC
LIMIT ?"""


@router.get("/api/worklist")
def worklist(limit: int = Query(50, ge=1, le=3000), include_flagged: bool = False):
    """Topics in fi + sv + en, highest score first. Topics flagged as "different subject" (the same
    Wikidata id, but the versions are about different things) are left out unless include_flagged."""
    sql = WORKLIST_SQL.format(where="" if include_flagged else "WHERE NOT d.different_subject")
    rows, ms = query(sql, (limit,))
    data = [{"wikidata_id": r["wikidata_id"],
             "titles": {"fi": r["title_fi"], "sv": r["title_sv"], "en": r["title_en"]},
             "fi_page_id": r["fi_page_id"], "score": _num(r["score"]),
             "fi_sv": _num(r["fi_sv"]), "fi_en": _num(r["fi_en"]),
             "missing_sv": r["missing_sv"], "missing_en": r["missing_en"],
             "missing_in_fi": {"sv": r["missing_in_fi_sv"], "en": r["missing_in_fi_en"]},
             "contradictions": r["contradictions"], "edit_war_score": _num(r["edit_war_score"])}
            for r in rows]
    return {"sql": render(sql, (limit,)), "ms": ms, "data": data}


TOPIC_SQL = """SELECT a.lang, a.page_id, a.title, a.url
FROM lang_topic t
JOIN lang_article a ON (a.lang, a.page_id) IN (('fi', t.fi_page_id), ('sv', t.sv_page_id), ('en', t.en_page_id))
WHERE t.wikidata_id = ?"""

SCORES_SQL = """SELECT VEC_DISTANCE_COSINE(f.embedding, s.embedding) AS fi_sv,
       VEC_DISTANCE_COSINE(f.embedding, e.embedding) AS fi_en,
       VEC_DISTANCE_COSINE(s.embedding, e.embedding) AS sv_en
FROM lang_topic t
JOIN lang_article_vector f ON f.lang = 'fi' AND f.page_id = t.fi_page_id
JOIN lang_article_vector s ON s.lang = 'sv' AND s.page_id = t.sv_page_id
JOIN lang_article_vector e ON e.lang = 'en' AND e.page_id = t.en_page_id
WHERE t.wikidata_id = ?"""

# Every Finnish sentence, with its aligned sv / en sentence (mutual best match closer than the
# threshold), and otherwise the sentence that covers it (its nearest one, closer than the threshold,
# but not mutual: e.g. one English sentence that says what two Finnish ones say).
FI_ROWS_SQL = f"""SELECT f.sent_no, f.text,
       ps.other_sent AS sv_sent, s.text AS sv_text, ps.distance AS sv_distance,
       pe.other_sent AS en_sent, e.text AS en_text, pe.distance AS en_distance,
       cs.other_sent AS cov_sv_sent, s2.text AS cov_sv_text, cs.distance AS cov_sv_distance,
       ce.other_sent AS cov_en_sent, e2.text AS cov_en_text, ce.distance AS cov_en_distance
FROM lang_topic t
JOIN lang_sentence f ON f.lang = 'fi' AND f.page_id = t.fi_page_id
LEFT JOIN lang_pair ps ON ps.wikidata_id = t.wikidata_id AND ps.other_lang = 'sv'
     AND ps.direction = 'fi' AND ps.fi_sent = f.sent_no AND ps.matched
LEFT JOIN lang_sentence s ON s.lang = 'sv' AND s.page_id = t.sv_page_id AND s.sent_no = ps.other_sent
LEFT JOIN lang_pair pe ON pe.wikidata_id = t.wikidata_id AND pe.other_lang = 'en'
     AND pe.direction = 'fi' AND pe.fi_sent = f.sent_no AND pe.matched
LEFT JOIN lang_sentence e ON e.lang = 'en' AND e.page_id = t.en_page_id AND e.sent_no = pe.other_sent
LEFT JOIN lang_pair cs ON cs.wikidata_id = t.wikidata_id AND cs.other_lang = 'sv' AND cs.direction = 'fi'
     AND cs.fi_sent = f.sent_no AND NOT cs.matched AND cs.distance < {THRESHOLD}
LEFT JOIN lang_sentence s2 ON s2.lang = 'sv' AND s2.page_id = t.sv_page_id AND s2.sent_no = cs.other_sent
LEFT JOIN lang_pair ce ON ce.wikidata_id = t.wikidata_id AND ce.other_lang = 'en' AND ce.direction = 'fi'
     AND ce.fi_sent = f.sent_no AND NOT ce.matched AND ce.distance < {THRESHOLD}
LEFT JOIN lang_sentence e2 ON e2.lang = 'en' AND e2.page_id = t.en_page_id AND e2.sent_no = ce.other_sent
WHERE t.wikidata_id = ?
ORDER BY f.sent_no"""

# sv / en sentences with NO Finnish sentence closer than the threshold (missing in Finnish); placed
# after their nearest Finnish sentence.
ONLY_SQL = f"""SELECT o.lang, o.sent_no, o.text, p.fi_sent AS nearest_fi, p.distance
FROM lang_topic t
JOIN lang_sentence o ON o.wikidata_id = t.wikidata_id AND o.lang IN ('sv', 'en')
     AND o.page_id = IF(o.lang = 'sv', t.sv_page_id, t.en_page_id)
JOIN lang_pair p ON p.wikidata_id = t.wikidata_id AND p.other_lang = o.lang
     AND p.direction = 'other' AND p.other_sent = o.sent_no
WHERE t.wikidata_id = ? AND NOT p.matched AND p.distance >= {THRESHOLD}
ORDER BY p.fi_sent, o.lang, o.sent_no"""

JUDGEMENTS_SQL = """SELECT fi_sent_no, other_lang, other_sent_no, label, reason, model
FROM pair_judgement
WHERE wikidata_id = ?
ORDER BY fi_sent_no, other_lang"""


def _edit_url(url: str) -> str:
    """https://fi.wikipedia.org/wiki/X -> https://fi.wikipedia.org/w/index.php?title=X&action=edit"""
    return url.replace("/wiki/", "/w/index.php?title=", 1) + "&action=edit"


@router.get("/api/compare/{wikidata_id}")
def compare(wikidata_id: str):
    q = (wikidata_id,)
    topic_rows, ms1 = query(TOPIC_SQL, q)
    if not topic_rows:
        raise HTTPException(404, f"{wikidata_id} is not one of the topics in fi + sv + en")
    by_lang = {r["lang"]: r for r in topic_rows}
    topic = {"wikidata_id": wikidata_id,
             "titles": {l: by_lang[l]["title"] for l in LANGS},
             "urls": {l: by_lang[l]["url"] for l in LANGS},
             "edit_urls": {l: _edit_url(by_lang[l]["url"]) for l in LANGS}}
    sc, ms2 = query(SCORES_SQL, q)
    scores = {k: _num(sc[0][k]) for k in ("fi_sv", "fi_en", "sv_en")} if sc else {}
    fi_rows, ms3 = query(FI_ROWS_SQL, q)
    sqls = [render(s, q) for s in (TOPIC_SQL, SCORES_SQL, FI_ROWS_SQL)]
    if not fi_rows:
        return {"sql": ";\n\n".join(sqls), "ms": round(ms1 + ms2 + ms3, 2), "topic": topic, "scores": scores,
                "rows": [], "note": "sentence data not computed yet for this topic"}
    only, ms4 = query(ONLY_SQL, q)
    try:
        judged, ms5 = query(JUDGEMENTS_SQL, q)
    except HTTPException:            # pair_judgement not created yet
        judged, ms5 = [], 0
    sqls += [render(ONLY_SQL, q), render(JUDGEMENTS_SQL, q)]
    jmap: dict = {}
    for j in judged:
        jmap.setdefault(j["fi_sent_no"], []).append(j)

    after: dict = {}
    for o in only:
        after.setdefault(o["nearest_fi"], []).append(o)
    rows = []
    for r in fi_rows:
        sv = {"sent_no": r["sv_sent"], "text": r["sv_text"], "distance": _num(r["sv_distance"])} \
            if r["sv_sent"] is not None else None
        en = {"sent_no": r["en_sent"], "text": r["en_text"], "distance": _num(r["en_distance"])} \
            if r["en_sent"] is not None else None
        cov = {l: {"sent_no": r[f"cov_{l}_sent"], "text": r[f"cov_{l}_text"], "distance": _num(r[f"cov_{l}_distance"])}
               if r[f"cov_{l}_sent"] is not None else None for l in ("sv", "en")}
        # covered counts as present: the content is there, just not as a one-to-one pair
        status = ("missing_en" if en is None and cov["en"] is None
                  else "missing_sv" if sv is None and cov["sv"] is None else "match")
        # judgements belong to this row's own pairs only
        js = [{"lang": j["other_lang"], "label": j["label"], "reason": j["reason"], "model": j["model"]}
              for j in jmap.get(r["sent_no"], [])
              if (j["other_lang"] == "sv" and sv and j["other_sent_no"] == sv["sent_no"])
              or (j["other_lang"] == "en" and en and j["other_sent_no"] == en["sent_no"])]
        rows.append({"fi": {"sent_no": r["sent_no"], "text": r["text"]}, "sv": sv, "en": en,
                     "covered_by": cov, "status": status, "judgements": js})
        for o in after.get(r["sent_no"], []):
            cell = {"sent_no": o["sent_no"], "text": o["text"], "distance": _num(o["distance"])}
            rows.append({"fi": None, "sv": cell if o["lang"] == "sv" else None,
                         "en": cell if o["lang"] == "en" else None,
                         "covered_by": {"sv": None, "en": None},
                         "status": f"only_{o['lang']}", "judgements": []})
    return {"sql": ";\n\n".join(sqls), "ms": round(ms1 + ms2 + ms3 + ms4 + ms5, 2),
            "topic": topic, "scores": scores, "rows": rows}


# Where each topic is on the globe: the Finnish article's own place (page_place, from Wikidata),
# else Kristian's article_geo (coordinates in the Finnish wikitext), else the place its article links
# most today (page_origin 2026, "inferred": Niinistö -> Salo, his birthplace). Different-subject topics
# left out.
LANG_LINES_SQL = """SELECT d.wikidata_id, fi.title AS title_fi, en.title AS title_en, sv.title AS title_sv,
       d.fi_sv, d.fi_en, d.score, d.missing_sv, d.missing_en,
       COALESCE(p.lat, g.lat, op.lat) AS lat, COALESCE(p.lon, g.lon, op.lon) AS lon,
       CASE WHEN p.title IS NOT NULL THEN 'page_place' WHEN g.page_id IS NOT NULL THEN 'article_geo'
            ELSE 'inferred' END AS located_by, op.title AS inferred_place
FROM article_divergence d
JOIN lang_topic t USING (wikidata_id)
JOIN lang_article fi ON fi.lang = 'fi' AND fi.page_id = t.fi_page_id
JOIN lang_article sv ON sv.lang = 'sv' AND sv.page_id = t.sv_page_id
JOIN lang_article en ON en.lang = 'en' AND en.page_id = t.en_page_id
LEFT JOIN page_place pp ON pp.page_id = t.fi_page_id
LEFT JOIN place p ON p.title = pp.place_title
LEFT JOIN article_geo g ON g.page_id = t.fi_page_id
LEFT JOIN page_origin o ON o.page_id = t.fi_page_id AND o.year = 2026
LEFT JOIN place op ON op.title = o.place_title
WHERE NOT d.different_subject
  AND (p.title IS NOT NULL OR g.page_id IS NOT NULL OR op.title IS NOT NULL)
ORDER BY d.score DESC"""


@router.get("/api/lang-lines")
def lang_lines():
    """Topics with a place, for the globe's "Language differences" view: one line per language,
    from the article to Stockholm (sv) and London (en), coloured by the whole-article distance."""
    rows, ms = query(LANG_LINES_SQL)
    data = [{"wikidata_id": r["wikidata_id"],
             "titles": {"fi": r["title_fi"], "sv": r["title_sv"], "en": r["title_en"]},
             "lat": float(r["lat"]), "lon": float(r["lon"]), "located_by": r["located_by"],
             "place": r["inferred_place"] if r["located_by"] == "inferred" else None,
             "fi_sv": _num(r["fi_sv"]), "fi_en": _num(r["fi_en"]), "score": _num(r["score"]),
             "missing_sv": r["missing_sv"], "missing_en": r["missing_en"]} for r in rows]
    return {"sql": LANG_LINES_SQL, "ms": ms, "data": data}
