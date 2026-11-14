"""Contested History API (owner: P1). Contract: plan §6.2, models in api/models.py.

    uvicorn api.main:app --reload            # http://localhost:8000/docs
"""
from __future__ import annotations

import mimetypes
import os
import time
from pathlib import Path
from typing import Literal

import pymysql
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from api import history as H
from api import models as M
from common.db import ROOT, Pool

app = FastAPI(title="Contested History", version="1.0",
              description="Sentence-level history of Finnish Wikipedia, from MariaDB system-versioned tables.")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])

pool = Pool(size=int(os.environ.get("DB_POOL", 8)))
Bucket = Literal["month", "quarter", "year"]


def run(fn, *args):
    try:
        with pool.connection() as conn:
            return fn(conn, *args)
    except H.NotFound as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(422, str(e))
    except pymysql.err.OperationalError as e:
        # Timeout or lost connection: say so instead of hanging (e.g. MariaDB stalled on a full disk).
        raise HTTPException(503, f"Database not responding ({e.args[-1] if e.args else e}). "
                                 "Check that MariaDB is running and its disk is not full.")


@app.get("/api/health")
def health():
    return run(lambda c: {"ok": True, "db": c.get_server_info()})


@app.get("/api/articles", response_model=list[M.ArticleSummary])
def list_articles(q: str = "", limit: int = Query(50, le=500)):
    return run(H.articles, q, limit)


@app.get("/api/articles/{page_id}/as-of", response_model=M.AsOf)
def as_of(page_id: int, date: str | None = Query(None, description="YYYY[-MM[-DD]] or ISO datetime, UTC; default now")):
    return run(H.as_of, page_id, date)


@app.get("/api/articles/{page_id}/diff", response_model=M.Diff)
def diff(page_id: int, from_: str = Query(..., alias="from"), to: str | None = None):
    return run(H.diff, page_id, from_, to)


@app.get("/api/articles/{page_id}/contested", response_model=list[M.Contested])
def contested(page_id: int):
    return run(H.contested, page_id)


@app.get("/api/articles/{page_id}/edit-wars", response_model=list[M.EditWar])
def edit_wars(page_id: int, limit: int = Query(20, le=200)):
    return run(H.edit_wars, page_id, limit)


@app.get("/api/articles/{page_id}/drift", response_model=list[M.Drift])
def drift(page_id: int, bucket: Bucket = "month"):
    return run(H.drift, page_id, bucket)


@app.get("/api/articles/{page_id}/term-drift", response_model=list[M.TermDrift])
def term_drift(page_id: int, terms: str | None = Query(None, description="comma-separated"),
               bucket: Bucket = "month"):
    return run(H.term_drift, page_id, terms.split(",") if terms else None, bucket)


@app.get("/api/articles/{page_id}/revisions", response_model=list[M.RevisionTick])
def revisions(page_id: int):
    return run(H.revisions, page_id)


@app.get("/api/articles/{page_id}/sentences/{sent_hash}/history", response_model=list[M.Ancestor])
def sentence_history(page_id: int, sent_hash: str):
    return run(H.sentence_history, page_id, sent_hash)


@app.get("/api/articles/{page_id}/about", response_model=list[M.About])
def about(page_id: int, from_: int = Query(..., alias="from", description="first year of the events"),
          to: int = Query(..., description="last year of the events (inclusive)"),
          date: str | None = Query(None, description="what Wikipedia said at this moment; default now")):
    """Bitemporal: sentences alive at `date` (system time) about events in `from`–`to` (application time)."""
    return run(H.about, page_id, date, from_, to)


@app.get("/api/about", response_model=list[M.AboutArticle])
def about_all(from_: int = Query(..., alias="from"), to: int = Query(...), date: str | None = None,
              limit: int = Query(50, le=500)):
    """Bitemporal across all articles: what Wikipedia said at `date` about events of `from`–`to`."""
    return run(H.about_all, date, from_, to, limit)


@app.get("/api/revisions/{rev_id}", response_model=M.Revision)
def revision(rev_id: int):
    return run(H.revision, rev_id)


_map_cache: dict = {}


@app.get("/api/map", response_model=list[M.MapPoint])
def map_points(refresh: bool = False):
    """Every placed article with its contestedness (cached 5 min: it aggregates all history)."""
    if refresh or not _map_cache or time.time() - _map_cache["at"] > 300:
        _map_cache.update(at=time.time(), data=run(H.map_points))
    return _map_cache["data"]


@app.get("/api/map/near", response_model=list[M.Near])
def map_near(lat: float, lon: float, deg: float = 1.0, limit: int = Query(10, le=50)):
    return run(H.near, lat, lon, deg, limit)


_stats_cache: dict = {}


@app.get("/api/stats", response_model=M.Stats)
def stats(refresh: bool = False):
    if refresh or not _stats_cache or time.time() - _stats_cache["at"] > 300:
        _stats_cache.update(at=time.time(),
                            data=run(H.stats, os.environ.get("DATASET", "small")))
    return _stats_cache["data"]


# The built frontend (web/dist) is served from the same origin for single-box deploys.
DIST = ROOT / "web" / "dist"
# Windows' registry often maps .js to text/plain, which browsers refuse for module scripts.
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        f = DIST / path
        return FileResponse(f if path and f.is_file() else DIST / "index.html")
