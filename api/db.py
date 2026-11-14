"""The API's database access: one connection pool and one error policy for both routers.

A missing table is not a crash: the combined database is loaded in stages (places first, sentences
later), so an endpoint whose tables are not there yet answers 503 and says which loader fills them.
"""
from __future__ import annotations

import os
import re

import pymysql
from fastapi import HTTPException

from common.db import Pool

pool = Pool(size=int(os.environ.get("DB_POOL", 8)))

LOADERS = {   # table -> the command that creates and fills it
    **dict.fromkeys(["article_sentence", "article_stats", "load_log"], "python -m ingest.replay --dataset small"),
    "sentence_score": "python -m scoring.score",
    "sentence_event_time": "python -m ingest.event_time",
    "article_geo": "python -m ingest.geo, then python -m ingest.replay",
    **dict.fromkeys(["place", "page_place"], "python -m ingest.places"),
    "place_link": "python -m ingest.place_links",
    **dict.fromkeys(["heat_year", "page_origin", "arc_year", "year_caption", "revert"], "python -m ingest.build_heat"),
    "article": "python -m ingest.load_parquet",
    **dict.fromkeys(["lang_article", "lang_article_vector", "lang_topic"], "python -m ingest.load_lang"),
    "lang_sentence": "python -m ingest.embed_cpu (stage 1) or the Verda import (stage 2)",
    "lang_pair": "python -m db.lang_match",
    **dict.fromkeys(["article_divergence", "pair_judgement"], "python -m db.build_divergence"),
    "article_sentence_order": "python -m ingest.replay --dataset large --sentences-only",
}


def db_error(e: Exception) -> HTTPException:
    """Turn a database error into an HTTP answer a person can act on."""
    code = e.args[0] if e.args else None
    text = str(e.args[-1]) if e.args else str(e)
    if isinstance(e, pymysql.err.ProgrammingError) and code == 1146:          # table doesn't exist
        m = re.search(r"'[^.']*\.([^']+)'", text)
        table = m.group(1) if m else "?"
        how = LOADERS.get(table)
        return HTTPException(503, f"Not loaded yet: table `{table}` does not exist in this database."
                                  + (f" Load it with: {how}" if how else ""))
    if isinstance(e, pymysql.err.OperationalError) and code == 1054:           # unknown column
        return HTTPException(503, f"Schema is out of date ({text}). Run: python -m common.migrate")
    if isinstance(e, pymysql.err.OperationalError):
        # Timeout or lost connection: say so instead of hanging (e.g. MariaDB stalled on a full disk).
        return HTTPException(503, f"Database not responding ({text}). "
                                  "Check that MariaDB is running and its disk is not full.")
    return HTTPException(500, f"Database error: {text}")


DB_ERRORS = (pymysql.err.OperationalError, pymysql.err.ProgrammingError)
