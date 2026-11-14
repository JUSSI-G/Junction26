"""Stage 4: the API behind the globe. Every response carries the SQL that produced it ("sql"), with
parameter values filled in for reading, and the database time in ms ("ms").

    .venv\\Scripts\\python -m uvicorn api:app --port 8000

GET /api/years                         years with heat data
GET /api/heat?year=&metric=            [{title, lat, lon, value, kind, category, is_country}]
GET /api/arcs?year=&limit=             [{from, to, weight, status: added|removed|same, pages}]
GET /api/place/{title}?date=           articles located at / linking the place as of the date
GET /api/article/{page_id}?date=       the article as of the date, edits and reverts up to then
"""
import time
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from common import connect
from heat_sql import METRICS, for_year
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
def heat(year: int, metric: str = "knowledge"):
    check_year(year)
    if metric not in METRICS:
        raise HTTPException(400, f"metric must be one of {', '.join(METRICS)}")
    sql = f"""SELECT h.place_title AS title, p.lat, p.lon, h.{metric} AS value,
       p.kind, p.category, p.is_country
FROM heat_year h JOIN place p ON p.title = h.place_title
WHERE h.year = ? AND h.{metric} > 0
ORDER BY value DESC"""
    rows, ms = query(sql, (year,))
    for r in rows:
        r["is_country"] = bool(r["is_country"])
    return {"sql": render(sql, (year,)), "ms": ms,
            "built_from": "\n\n".join(for_year(s, year) for s in METRICS[metric]), "data": rows}


# One arc per (origin place, linked place, status). origin = the article's own place (page_place).
ARCS_SQL = """SELECT f.title AS from_title, f.lat AS from_lat, f.lon AS from_lon,
       t.title AS to_title, t.lat AS to_lat, t.lon AS to_lon,
       x.status, COUNT(DISTINCT x.page_id) AS weight, GROUP_CONCAT(DISTINCT x.page_id) AS pages
FROM (
  -- green: link added during the year
  SELECT page_id, to_place, 'added' AS status
  FROM place_link FOR SYSTEM_TIME ALL
  WHERE row_start >= TIMESTAMP'{y0}' AND row_start < TIMESTAMP'{y1}'
  UNION ALL
  -- red: link removed during the year
  SELECT page_id, to_place, 'removed'
  FROM place_link FOR SYSTEM_TIME ALL
  WHERE row_end >= TIMESTAMP'{y0}' AND row_end < TIMESTAMP'{y1}'
  UNION ALL
  -- grey: there on 1 Jan and still there (same row) at the end of the year
  SELECT page_id, to_place, 'same'
  FROM place_link FOR SYSTEM_TIME AS OF TIMESTAMP'{y1}'
  WHERE row_start < TIMESTAMP'{y0}'
) x
JOIN page_place pp ON pp.page_id = x.page_id
JOIN place f ON f.title = pp.place_title
JOIN place t ON t.title = x.to_place
WHERE f.title <> t.title
GROUP BY f.title, t.title, x.status
ORDER BY FIELD(x.status, 'added', 'removed', 'same'), weight DESC, t.title
LIMIT {limit}"""


@app.get("/api/arcs")
def arcs(year: int, limit: int = Query(200, ge=1, le=5000)):
    check_year(year)
    sql = for_year(ARCS_SQL.replace("{limit}", str(int(limit))), year)
    rows, ms = query(sql)
    data = [{"from": {"title": r["from_title"], "lat": r["from_lat"], "lon": r["from_lon"]},
             "to": {"title": r["to_title"], "lat": r["to_lat"], "lon": r["to_lon"]},
             "weight": r["weight"], "status": r["status"],
             "pages": [int(p) for p in str(r["pages"]).split(",")]} for r in rows]
    return {"sql": sql, "ms": ms, "data": data}


PLACE_SQL = """SELECT title, qid, lat, lon, kind, category, is_country FROM place WHERE title = ?"""
PLACE_ARTICLES_SQL = """SELECT a.page_id, a.title, a.rev_id, a.len, 'located here' AS relation,
       NULL AS mentions, a.row_start AS saved
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP ? a
JOIN page_place pp ON pp.page_id = a.page_id
WHERE pp.place_title = ?
UNION ALL
SELECT a.page_id, a.title, a.rev_id, a.len, 'links here', l.mentions, a.row_start
FROM place_link FOR SYSTEM_TIME AS OF TIMESTAMP ? l
JOIN article FOR SYSTEM_TIME AS OF TIMESTAMP ? a ON a.page_id = l.page_id
WHERE l.to_place = ?
ORDER BY relation DESC, len DESC"""


@app.get("/api/place/{title}")
def place(title: str, date: str | None = None):
    m = moment(date)
    info, ms1 = query(PLACE_SQL, (title,))
    if not info:
        raise HTTPException(404, f"no place '{title}'")
    params = (m, title, m, m, title)
    rows, ms2 = query(PLACE_ARTICLES_SQL, params)
    for r in rows:
        r["saved"] = str(r["saved"])
        r["oldid_url"] = f"https://fi.wikipedia.org/?oldid={r['rev_id']}"
    p = info[0]
    p["is_country"] = bool(p["is_country"])
    return {"sql": render(PLACE_SQL, (title,)) + ";\n\n" + render(PLACE_ARTICLES_SQL, params),
            "ms": round(ms1 + ms2, 2), "date": m, "place": p, "data": rows}


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
