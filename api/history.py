"""The history queries behind every view. Each function takes a DB connection and returns plain
JSON-ready data in the shape of the API contract (plan §6.2). SQL lives in db/queries/*.sql.
"""
from __future__ import annotations

import re
import time
from datetime import date, datetime, timedelta
from decimal import Decimal

from common.db import load_query

STEP_DELTA = {"month": 1, "quarter": 3, "year": 12}


class NotFound(Exception):
    pass


# --- helpers -----------------------------------------------------------------------------------

def moment(value: str | date | datetime | None) -> str:
    """'2012', '2012-03', '2012-03-04', '2012-03-04T10:00[:00][Z]' -> 'YYYY-MM-DD HH:MM:SS.ffffff'.
    MariaDB's `TIMESTAMP %s` refuses a bare date. None = now."""
    if value is None:
        return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S.%f")
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S.%f")
    if isinstance(value, date):
        return f"{value:%Y-%m-%d} 00:00:00.000000"
    v = str(value).strip().replace("T", " ").rstrip("Z")
    if re.fullmatch(r"\d{4}", v):
        v += "-01-01"
    elif re.fullmatch(r"\d{4}-\d{2}", v):
        v += "-01"
    try:
        dt = datetime.fromisoformat(v)
    except ValueError as e:
        raise ValueError(f"not a date: {value!r}") from e
    return dt.strftime("%Y-%m-%d %H:%M:%S.%f")


def iso(dt: datetime | None) -> str | None:
    """Datetime -> ISO-8601 UTC; MariaDB's 'still current' row_end (2038/2106) -> None."""
    if dt is None or dt.year >= 2038:
        return None
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def hx(b: bytes | None) -> str | None:
    return b.hex() if b is not None else None


def num(v):
    if isinstance(v, Decimal):
        return float(v)
    return v


def _rows(conn, name: str, params: dict, **fmt) -> list[dict]:
    """Run db/queries/<name>.sql. `fmt` fills {placeholders} with server-side-generated SQL
    fragments only (whitelisted numbers / column lists), never with user input."""
    sql = load_query(name)
    for key, value in fmt.items():
        sql = sql.replace("{" + key + "}", str(value))
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return list(cur.fetchall())


def _order(blob: bytes | None) -> dict[bytes, int]:
    if not blob:
        return {}
    return {blob[i:i + 32]: i // 32 for i in range(0, len(blob), 32)}


# --- views -------------------------------------------------------------------------------------

def articles(conn, q: str = "", limit: int = 50) -> list[dict]:
    rows = _rows(conn, "articles", {"q": f"%{q}%", "limit": limit})
    return [dict(page_id=r["page_id"], title=r["title"], revisions=r["revisions"],
                 first_rev=iso(r["first_rev"]), last_rev=iso(r["last_rev"]),
                 n_sentences=r["n_sentences"]) for r in rows]


def as_of(conn, page_id: int, when=None) -> dict:
    p = {"page_id": page_id, "ts": moment(when)}
    art = _rows(conn, "as_of_article", p)
    if not art:
        raise NotFound(f"article {page_id} did not exist at {p['ts']}")
    a = art[0]
    order = _order(a["sentence_order"])
    sents = _rows(conn, "as_of_sentences", p)
    sents.sort(key=lambda s: order.get(s["sent_hash"], 10**9 + s["position"]))
    return dict(
        page_id=page_id, title=a["title"], rev_id=a["rev_id"], timestamp=iso(a["ts"]),
        editor=a["editor"], anonymous=bool(a["anonymous"]), comment=a["comment"],
        sentences=[dict(hash=hx(s["sent_hash"]), text=s["text"], position=i,
                        since=iso(s["since"]), editor=s["editor"], rev_id=s["rev_id"])
                   for i, s in enumerate(sents)])


def diff(conn, page_id: int, frm, to) -> dict:
    p = {"page_id": page_id, "from": moment(frm), "to": moment(to)}
    out = dict(added=[], removed=[], kept=0)
    for r in _rows(conn, "diff", p):
        if r["kind"] == "kept":
            out["kept"] = int(r["position"] or 0)
        else:
            out[r["kind"]].append(dict(hash=hx(r["sent_hash"]), text=r["text"],
                                       editor=r["editor"], rev_id=r["rev_id"]))
    return out


def contested(conn, page_id: int) -> list[dict]:
    rows = _rows(conn, "contested", {"page_id": page_id})
    if not rows:
        return []
    cur = _rows(conn, "as_of_article", {"page_id": page_id, "ts": moment(None)})
    order = _order(cur[0]["sentence_order"]) if cur else {}
    rows.sort(key=lambda r: order.get(r["sent_hash"], 10**9 + r["position"]))
    return [dict(hash=hx(r["sent_hash"]), text=r["text"], position=i, lives=r["lives"],
                 rewrites=int(r["rewrites"] or 0), total_days_alive=num(r["total_days_alive"]),
                 since=iso(r["since"]), first_seen=iso(r["first_seen"]), editor=r["editor"])
            for i, r in enumerate(rows)]


def edit_wars(conn, page_id: int, limit: int = 20) -> list[dict]:
    out: dict[bytes, dict] = {}
    for r in _rows(conn, "edit_wars", {"page_id": page_id, "limit": limit}):
        w = out.setdefault(r["sent_hash"], dict(hash=hx(r["sent_hash"]), text=r["text"],
                                                lives=r["lives"], periods=[]))
        w["periods"].append(dict(
            **{"from": iso(r["from"]), "to": iso(r["to"])}, editor=r["editor"],
            anonymous=bool(r["anonymous"]), rev_id=r["rev_id"], removed_by=r["removed_by"],
            removed_by_anonymous=bool(r["removed_by_anonymous"]) if r["removed_by_anonymous"] is not None else None,
            removed_rev=r["removed_rev"], removed_comment=r["removed_comment"]))
    return list(out.values())


def _period_label(start: datetime, bucket: str) -> str:
    if bucket == "year":
        return f"{start:%Y}"
    if bucket == "quarter":
        return f"{start:%Y}-Q{(start.month - 1) // 3 + 1}"
    return f"{start:%Y-%m}"


def _period_end(start: datetime, bucket: str) -> str:
    months = start.month - 1 + STEP_DELTA[bucket]
    end = start.replace(year=start.year + months // 12, month=months % 12 + 1)
    return iso(end - timedelta(seconds=1))


def drift(conn, page_id: int, bucket: str = "month") -> list[dict]:
    rows = _rows(conn, "drift", {"page_id": page_id}, months=STEP_DELTA[bucket])
    return [dict(period=_period_label(r["period_start"], bucket), period_end=_period_end(r["period_start"], bucket),
                 event_name=r["event_name"], n=int(r["n"]), avg_neutrality=num(r["avg_neutrality"]),
                 loaded=int(r["loaded"] or 0), partisan=int(r["partisan"] or 0)) for r in rows]


DEFAULT_TERMS = ["vapaussota", "sisällissota", "kansalaissota", "punakapina", "luokkasota", "veljessota"]


def term_drift(conn, page_id: int, terms: list[str] | None = None, bucket: str = "month") -> list[dict]:
    terms = [t.strip().lower() for t in (terms or DEFAULT_TERMS) if t.strip()][:12]
    idx = range(len(terms))
    params = {"page_id": page_id, **{f"term_{i}": t for i, t in enumerate(terms)}}
    # Byte-wise LOCATE on lowercased text: 2x faster than LIKE under utf8mb4_unicode_ci, same counts.
    rows = _rows(conn, "term_drift", params, months=STEP_DELTA[bucket],
                 flag_columns="".join(f", LOCATE(%(term_{i})s, CAST(LOWER(text) AS BINARY)) > 0 AS t_{i}" for i in idx),
                 sum_columns="".join(f", SUM(d * t_{i}) AS t_{i}" for i in idx),
                 run_columns="".join(f", SUM(COALESCE(delta.t_{i}, 0)) OVER w AS t_{i}" for i in idx))
    return [dict(period=_period_label(r["period_start"], bucket), period_end=_period_end(r["period_start"], bucket),
                 sentences=int(r["sentences"] or 0), terms={t: int(r[f"t_{i}"] or 0) for i, t in enumerate(terms)})
            for r in rows]


def revisions(conn, page_id: int) -> list[dict]:
    return [dict(rev_id=r["rev_id"], timestamp=iso(r["ts"]), editor=r["editor"],
                 anonymous=bool(r["anonymous"]), comment=r["comment"], minor=bool(r["minor"]),
                 n_sentences=r["n_sentences"], is_revert=bool(r["is_revert"]))
            for r in _rows(conn, "revisions", {"page_id": page_id})]


def revision(conn, rev_id: int) -> dict:
    rows = _rows(conn, "revision", {"rev_id": rev_id})
    if not rows:
        raise NotFound(f"revision {rev_id} not found")
    r = rows[0]
    return dict(rev_id=r["rev_id"], page_id=r["page_id"], title=r["title"], timestamp=iso(r["ts"]),
                until=iso(r["ts_end"]), editor=r["editor"], anonymous=bool(r["anonymous"]),
                comment=r["comment"], minor=bool(r["minor"]), n_sentences=r["n_sentences"],
                url=f"https://fi.wikipedia.org/?oldid={r['rev_id']}")


def sentence_history(conn, page_id: int, sent_hash: str) -> list[dict]:
    try:
        h = bytes.fromhex(sent_hash)
    except ValueError as e:
        raise NotFound("bad hash") from e
    rows = _rows(conn, "sentence_history", {"page_id": page_id, "hash": h})
    if not rows:
        raise NotFound("sentence not found")
    return [dict(hash=hx(r["sent_hash"]), text=r["text"], editor=r["editor"],
                 anonymous=bool(r["anonymous"]), rev_id=r["rev_id"],
                 **{"from": iso(r["from"]), "to": iso(r["to"])}, depth=r["depth"],
                 tone=r["tone"], neutrality=num(r["neutrality"]), event_name=r["event_name"])
            for r in rows]


# --- bitemporal: system time (when Wikipedia said it) x application time (when it happened) -----

def _year_range(frm, to) -> tuple[str, str]:
    """Years 'YYYY' (inclusive) -> [YYYY-01-01, (to+1)-01-01) for the period overlap test."""
    a, b = int(frm), int(to)
    if not (1000 <= a <= 9998 and 1000 <= b <= 9998) or b < a:
        raise ValueError("years must be 1000..9998 and from <= to")
    return f"{a:04d}-01-01", f"{b + 1:04d}-01-01"


def about(conn, page_id: int, when, frm: int, to: int) -> list[dict]:
    lo, hi = _year_range(frm, to)
    rows = _rows(conn, "about", {"page_id": page_id, "ts": moment(when), "from": lo, "to": hi})
    return [dict(hash=hx(r["sent_hash"]), text=r["text"], event_from=r["event_from"].year,
                 event_to=r["event_to"].year - 1) for r in rows]


def about_all(conn, when, frm: int, to: int, limit: int = 50) -> list[dict]:
    lo, hi = _year_range(frm, to)
    rows = _rows(conn, "about_all", {"ts": moment(when), "from": lo, "to": hi, "limit": limit})
    return [dict(page_id=r["page_id"], title=r["title"], sentences=r["sentences"],
                 sample=(r["sample"] or "").split("\n")) for r in rows]


# --- the globe -----------------------------------------------------------------------------------

def map_points(conn) -> list[dict]:
    rows = _rows(conn, "map", {})
    out = []
    for r in rows:
        revisions, reverts, returns = int(r["revisions"]), int(r["reverts"] or 0), int(r["returns"] or 0)
        out.append(dict(page_id=r["page_id"], title=r["title"], lat=r["lat"], lon=r["lon"],
                        source=r["source"], revisions=revisions, reverts=reverts, returns=returns,
                        churn=round(float(r["churn"] or 0), 2), n_sentences=r["n_sentences"],
                        contested=returns + reverts, first_rev=iso(r["first_rev"]),
                        last_rev=iso(r["last_rev"])))
    return out


def near(conn, lat: float, lon: float, deg: float = 1.0, limit: int = 10) -> list[dict]:
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("lat/lon out of range")
    rows = _rows(conn, "near", {"lat": lat, "lon": lon, "deg": min(max(deg, 0.05), 20), "limit": limit})
    return [dict(page_id=r["page_id"], title=r["title"], lat=r["lat"], lon=r["lon"],
                 source=r["source"], km=num(r["km"])) for r in rows]


# --- /stats ------------------------------------------------------------------------------------

def _p95(xs: list[float]) -> float:
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(0.95 * len(xs) + 0.999) - 1)], 2)


def stats(conn, dataset: str, runs: int = 5) -> dict:
    counts = _rows(conn, "stats_counts", {})[0]
    scored_by = {r["model"]: int(r["n"]) for r in _rows(conn, "stats_models", {})}
    out = dict(dataset=dataset, **{k: int(v or 0) for k, v in counts.items()}, query_ms={},
               sample_article=None, scored_by=scored_by)
    top = articles(conn, "", 1)
    if not top:
        return out
    a = top[0]
    out["sample_article"] = dict(page_id=a["page_id"], title=a["title"], revisions=a["revisions"])
    mid = "2012-06-01"
    bench = {
        "as_of": lambda: as_of(conn, a["page_id"], max(mid + "T00:00:00Z", a["first_rev"])),
        "diff": lambda: diff(conn, a["page_id"], max("2008-01-01T00:00:00Z", a["first_rev"]), None),
        "contested": lambda: contested(conn, a["page_id"]),
        "edit_wars": lambda: edit_wars(conn, a["page_id"], 20),
        "drift": lambda: drift(conn, a["page_id"], "month"),
        "term_drift": lambda: term_drift(conn, a["page_id"], None, "month"),
    }
    for name, fn in bench.items():
        times = []
        for _ in range(runs):
            t = time.perf_counter()
            fn()
            times.append((time.perf_counter() - t) * 1000)
        out["query_ms"][name] = dict(p95=_p95(times), median=round(sorted(times)[len(times) // 2], 2))
    return out
