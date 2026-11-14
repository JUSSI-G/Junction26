"""Create the tables from db/schema.sql.

    python -m common.schema            # create missing tables (safe to re-run)
    python -m common.schema --reset    # drop and recreate everything (asks no questions!)
    python -m common.schema --db wiki_test
"""
from __future__ import annotations

import argparse
import re

import pymysql

from common.db import ROOT, connect, settings

TABLES = ["sentence_score", "sentence_event_time", "article_sentence", "article", "article_geo",
          "article_stats", "load_log"]


def apply(database: str | None = None, reset: bool = False) -> None:
    name = database or settings()["database"]
    server = connect(database="", autocommit=True)
    with server.cursor() as cur:
        cur.execute(f"CREATE DATABASE IF NOT EXISTS `{name}` CHARACTER SET utf8mb4")
    server.close()

    conn = connect(name, autocommit=True)
    with conn.cursor() as cur:
        if reset:
            for t in TABLES:
                cur.execute(f"DROP TABLE IF EXISTS `{t}`")
        sql = re.sub(r"--[^\n]*", "", (ROOT / "db" / "schema.sql").read_text(encoding="utf-8"))
        for statement in sql.split(";"):
            if statement.strip():
                cur.execute(statement)
        cur.execute("SHOW TABLES")
        tables = [next(iter(r.values())) for r in cur.fetchall()]
    conn.close()
    print(f"{name}: {', '.join(sorted(tables))}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--db", default=None)
    p.add_argument("--reset", action="store_true")
    a = p.parse_args()
    try:
        apply(a.db, a.reset)
    except pymysql.err.OperationalError as e:
        raise SystemExit(f"Cannot reach MariaDB ({e}). Is it running? -> make db")
