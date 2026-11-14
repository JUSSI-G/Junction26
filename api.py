"""Stage 4: the API behind the globe. Every response carries the SQL that produced it ("sql"), with
parameter values filled in for reading, and the database time in ms ("ms").

    .venv\\Scripts\\python -m uvicorn api:app --port 8000

GET /api/years                         years with heat data
GET /api/heat?year=&metric=&limit=     [{title, en_label, lat, lon, value, kind, category, is_country}]
GET /api/arcs?year=&limit=&all=&page=  [{from, to, weight, status: added|removed|same, origin_inferred, articles}]
GET /api/captions                      per year: links added/removed, the biggest single edit, Gemma's reason if any
GET /api/place/{title}?date=           articles located at / linking the place as of the date
GET /api/article/{page_id}?date=       the article as of the date, edits and reverts up to then
"""
import time
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os
from common import connect, ROOT
from heat_sql import METRICS, ARC_EVENTS, ARCS, YEAR_TOTALS, BIGGEST_EDITS, for_year
from textclean import clean

app = FastAPI(title="Rewritten API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])

YEAR_MIN, YEAR_MAX = 2004, 2026


def render(sql, params):
    """SQL with ? replaced by the values, for display in the SQL drawer (execution uses params)."""
    out, it = [], iter(params)
    for part in sql.split("?"):
        out.append(part)
        try:
            v = next(it)
        except StopIteration:
            continue
        out.append(str(v) if isinstance(v, (int, float)) else "'" + str(v).replace("'", "''") + "'")
    return "".join(out).strip()


def query(sql, params=()):
    """Run one query on a fresh connection; returns (rows as dicts, ms)."""
    con = connect()
    try:
        cur = con.cursor()
        t = time.perf_counter()
        cur.execute(sql, params)
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
        return rows, round((time.perf_counter() - t) * 1000, 2)
    finally:
        con.close()


def moment(date):
    """'YYYY-MM-DD' or ISO datetime (UTC) -> 'YYYY-MM-DD HH:MM:SS'; default: now."""
    if not date:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    try:
        return datetime.fromisoformat(date.replace("Z", "")).strftime("%Y-%m-%d %H:%M:%S")
    except ValueError:
        raise HTTPException(400, "date must be YYYY-MM-DD or an ISO datetime")


def check_year(year):
    if not YEAR_MIN <= year <= YEAR_MAX:
        raise HTTPException(400, f"year must be {YEAR_MIN}-{YEAR_MAX}")
    return year


@app.get("/api/years")
def years():
    sql = "SELECT DISTINCT year FROM heat_year ORDER BY year"
    rows, ms = query(sql)
    return {"sql": sql, "ms": ms, "data": [r["year"] for r in rows]}


@app.get("/api/heat")
def heat(year: int, metric: str = "knowledge", limit: int = Query(1500, ge=1, le=20000)):
    """Countries first (they are drawn as polygons), then the strongest places, up to `limit`."""
    check_year(year)
    if metric not in METRICS:
        raise HTTPException(400, f"metric must be one of {', '.join(METRICS)}")
    sql = f"""SELECT h.place_title AS title, p.en_label, p.qid, p.lat, p.lon, h.{metric} AS value,
       p.kind, p.category, p.is_country
FROM heat_year h JOIN place p ON p.title = h.place_title
WHERE h.year = ? AND h.{metric} > 0
ORDER BY p.is_country DESC, value DESC
LIMIT ?"""
    rows, ms = query(sql, (year, limit))
    for r in rows:
        r["is_country"] = bool(r["is_country"])
    return {"sql": render(sql, (year, limit)), "ms": ms,
            "built_from": "\n\n".join(for_year(s, year) for s in METRICS[metric]), "data": rows}


def arc_rows(rows):
    data = []
    for r in rows:
        arts = [x.split(":", 1) for x in str(r["articles"] or "").split("|") if ":" in x]
        data.append({"from": {"title": r["from_title"], "en_label": r["from_en"],
                              "lat": r["from_lat"], "lon": r["from_lon"]},
                     "to": {"title": r["to_title"], "en_label": r["to_en"],
                            "lat": r["to_lat"], "lon": r["to_lon"]},
                     "weight": r["weight"], "status": r["status"],
                     "origin_inferred": bool(r["origin_inferred"]),
                     "articles": [{"page_id": int(p), "title": t} for p, t in arts]})
    return data


# Whole collection: read the precomputed arc_year (built by build_heat.py from the SVT query that
# the response shows as built_from). rnk 1 = the arc carried by the most articles.
ARCS_READ_SQL = """SELECT f.title AS from_title, f.en_label AS from_en, f.lat AS from_lat, f.lon AS from_lon,
       t.title AS to_title, t.en_label AS to_en, t.lat AS to_lat, t.lon AS to_lon,
       a.status, a.inferred AS origin_inferred, a.weight, a.articles
FROM arc_year a
JOIN place f ON f.title = a.from_place
JOIN place t ON t.title = a.to_place
WHERE a.year = ? AND a.rnk <= ?{only}
ORDER BY FIELD(a.status, 'added', 'removed', 'same'), a.inferred, a.rnk"""

# One article: straight from the system-versioned table, no precomputing needed.
ARCS_PAGE_SQL = """SELECT f.title AS from_title, f.en_label AS from_en, f.lat AS from_lat, f.lon AS from_lon,
       t.title AS to_title, t.en_label AS to_en, t.lat AS to_lat, t.lon AS to_lon,
       x.status, o.inferred AS origin_inferred, 1 AS weight,
       CONCAT(a.page_id, ':', a.title) AS articles
FROM (""" + ARC_EVENTS + """
) x
JOIN page_origin o ON o.page_id = x.page_id AND o.year = {year}
JOIN place f ON f.title = o.place_title
JOIN place t ON t.title = x.to_place
JOIN article a ON a.page_id = x.page_id
WHERE x.page_id = {page} AND f.title <> t.title
ORDER BY FIELD(x.status, 'added', 'removed', 'same'), t.title
LIMIT {limit}"""


@app.get("/api/arcs")
def arcs(year: int, limit: int = Query(150, ge=1, le=5000), page: int | None = None,
         all: bool = False):
    """Default: the `limit` strongest added and removed arcs with a known origin.
    all=1 adds unchanged arcs and arcs with an inferred origin (`limit` per group).
    page= returns every arc of one article."""
    check_year(year)
    if page is not None:
        sql = for_year(ARCS_PAGE_SQL.replace("{page}", str(int(page))).replace("{limit}", "2000"), year)
        rows, ms = query(sql)
        return {"sql": sql, "ms": ms, "data": arc_rows(rows)}
    only = "" if all else "\n  AND a.inferred = 0 AND a.status IN ('added', 'removed')"
    sql = ARCS_READ_SQL.replace("{only}", only)
    rows, ms = query(sql, (year, limit))
    return {"sql": render(sql, (year, limit)), "ms": ms,
            "built_from": for_year(ARCS.replace("{cap}", "1500"), year), "data": arc_rows(rows)}


CAPTIONS_SQL = """SELECT c.year, c.added, c.removed, c.page_id, c.title, c.rev_id, c.user, c.comment,
       c.saved, c.n_added, c.n_removed{reason}
FROM year_caption c{join}
ORDER BY c.year"""


@app.get("/api/captions")
def captions():
    """Per year: place links added/removed, and the single edit that changed the most links.
    `reason`/`label` come from change_reason (Gemma, stage 7) when that table exists, else null."""
    has, _ = query("""SELECT COUNT(*) AS n FROM information_schema.tables
                      WHERE table_schema = DATABASE() AND table_name = 'change_reason'""")
    if has[0]["n"]:
        sql = CAPTIONS_SQL.format(reason=", r.reason, r.label", join="""
LEFT JOIN change_reason r ON r.page_id = c.page_id AND r.rev_id = c.rev_id""")
    else:
        sql = CAPTIONS_SQL.format(reason=", NULL AS reason, NULL AS label", join="")
    rows, ms = query(sql)
    for r in rows:
        r["saved"] = str(r["saved"]) if r["saved"] else None
        r["diff_url"] = f"https://fi.wikipedia.org/?diff={r['rev_id']}" if r["rev_id"] else None
    return {"sql": sql, "ms": ms,
            "built_from": "-- year_caption is built per year from the system-versioned table, e.g. 2014:\n"
                          + for_year(YEAR_TOTALS, 2014) + ";\n\n" + for_year(BIGGEST_EDITS, 2014),
            "data": rows}


PLACE_SQL = """SELECT title, en_label, qid, lat, lon, kind, category, is_country FROM place WHERE title = ?"""
PLACE_COUNT_SQL = """SELECT COUNT(*) AS linking
FROM place_link FOR SYSTEM_TIME AS OF TIMESTAMP ?
WHERE to_place = ?"""
PLACE_ARTICLES_SQL = """SELECT a.page_id, a.title, a.rev_id, a.len, 'located here' AS relation,
       NULL AS mentions, a.row_start AS saved
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP ? a
JOIN page_place pp ON pp.page_id = a.page_id
WHERE pp.place_title = ?
UNION ALL
SELECT a.page_id, a.title, a.rev_id, a.len, 'links here', l.mentions, a.row_start
FROM (SELECT page_id, mentions
      FROM place_link FOR SYSTEM_TIME AS OF TIMESTAMP ?
      WHERE to_place = ?
      ORDER BY mentions DESC, page_id LIMIT ?) l
JOIN article FOR SYSTEM_TIME AS OF TIMESTAMP ? a ON a.page_id = l.page_id
ORDER BY relation DESC, mentions DESC, len DESC"""


@app.get("/api/place/{title}")
def place(title: str, date: str | None = None, limit: int = Query(200, ge=1, le=2000)):
    """Articles located at the place, and the `limit` articles that link it most, as of the date."""
    m = moment(date)
    info, ms1 = query(PLACE_SQL, (title,))
    if not info:
        raise HTTPException(404, f"no place '{title}'")
    total, ms3 = query(PLACE_COUNT_SQL, (m, title))
    params = (m, title, m, title, limit, m)
    rows, ms2 = query(PLACE_ARTICLES_SQL, params)
    for r in rows:
        r["saved"] = str(r["saved"])
        r["oldid_url"] = f"https://fi.wikipedia.org/?oldid={r['rev_id']}"
    p = info[0]
    p["is_country"] = bool(p["is_country"])
    return {"sql": render(PLACE_COUNT_SQL, (m, title)) + ";\n\n" + render(PLACE_ARTICLES_SQL, params),
            "ms": round(ms1 + ms2 + ms3, 2), "date": m, "place": p,
            "linking_total": total[0]["linking"], "data": rows}


ARTICLE_SQL = """SELECT page_id, title, rev_id, user, comment, len, text, row_start, row_end
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP ?
WHERE page_id = ?"""
ARTICLE_STATS_SQL = """SELECT COUNT(*) AS edits, COALESCE(SUM(is_revert), 0) AS reverts,
       MIN(row_start) AS first_edit
FROM (SELECT row_start,
             sha1 <> LAG(sha1) OVER (ORDER BY row_start)
               AND MIN(row_start) OVER (PARTITION BY sha1) < row_start AS is_revert
      FROM article FOR SYSTEM_TIME ALL
      WHERE page_id = ?) v
WHERE row_start <= TIMESTAMP ?"""


@app.get("/api/article/{page_id}")
def article(page_id: int, date: str | None = None):
    m = moment(date)
    rows, ms1 = query(ARTICLE_SQL, (m, page_id))
    if not rows:
        raise HTTPException(404, f"article {page_id} did not exist on {m}")
    stats, ms2 = query(ARTICLE_STATS_SQL, (page_id, m))
    a = rows[0]
    current = a["row_end"].year >= 2038
    return {"sql": render(ARTICLE_SQL, (m, page_id)) + ";\n\n"
                   + render(ARTICLE_STATS_SQL, (page_id, m)),
            "ms": round(ms1 + ms2, 2), "date": m,
            "page_id": a["page_id"], "title": a["title"], "rev_id": a["rev_id"],
            "oldid_url": f"https://fi.wikipedia.org/?oldid={a['rev_id']}",
            "user": a["user"], "comment": a["comment"], "len": a["len"],
            "saved": str(a["row_start"]), "until": None if current else str(a["row_end"]),
            "edits_to_date": int(stats[0]["edits"]), "reverts_to_date": int(stats[0]["reverts"]),
            "first_edit": str(stats[0]["first_edit"]),
            "blocks": [{"kind": k, "text": t} for k, t in clean(a["text"])]}


# The built frontend (web/dist, from `npm run build` in web/), so one command serves everything.
_dist = os.path.join(ROOT, "web", "dist")
if os.path.isdir(_dist):
    app.mount("/", StaticFiles(directory=_dist, html=True), name="web")
