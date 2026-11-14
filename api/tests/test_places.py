"""The place routes and the place tables, against the loaded database (DB_NAME in .env).

Unlike test_history.py these do not build a test database: place links for all of dataset M take
minutes to build, so the checks run on the real one and skip when it is not there.
The expected numbers are for all 19,742 articles of dataset M (NOTES.md, "Sanity checks").
"""
from __future__ import annotations

import pymysql
import pytest
from fastapi.testclient import TestClient

from api.main import app
from common.db import connect

HERO = 1150            # Suomen sisällissota


def _loaded() -> tuple[bool, bool]:
    """(place tables present, all of dataset M loaded)"""
    try:
        c = connect(dict_rows=False)
    except pymysql.err.OperationalError:
        return False, False
    try:
        with c.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM place_link")
            if not cur.fetchone()[0]:
                return False, False
            cur.execute("SELECT COUNT(*) FROM article")
            return True, cur.fetchone()[0] == 19742
    except pymysql.err.ProgrammingError:
        return False, False
    finally:
        c.close()


PLACES, FULL = _loaded()
needs_places = pytest.mark.skipif(not PLACES, reason="place tables not loaded (python -m ingest.place_links)")
full_scale = pytest.mark.skipif(not FULL, reason="numbers are for all of dataset M")


def _db_up() -> bool:
    try:
        connect().close()
        return True
    except pymysql.err.OperationalError:
        return False


needs_db = pytest.mark.skipif(not _db_up(), reason="MariaDB not reachable")


@pytest.fixture(scope="module")
def cur():
    c = connect(dict_rows=False)
    yield c.cursor()
    c.close()


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


@full_scale
@pytest.mark.parametrize("as_of, places", [("TIMESTAMP'2005-01-01 00:00:00'", 4),
                                           ("TIMESTAMP'2010-01-01 00:00:00'", 65),
                                           ("TIMESTAMP'2018-01-01 00:00:00'", 107),
                                           ("NOW()", 112)])
def test_hero_article_places_over_time(cur, as_of, places):
    cur.execute(f"SELECT COUNT(*) FROM place_link FOR SYSTEM_TIME AS OF {as_of} WHERE page_id = %s", (HERO,))
    assert cur.fetchone()[0] == places


@full_scale
def test_camp_edit_of_2014(cur):
    """11 Feb 2014: the links move from the towns to their prison camps, in one edit."""
    when = ("2014-02-11 02:10:12", "2014-02-11 02:10:13")
    cur.execute("SELECT to_place FROM place_link FOR SYSTEM_TIME ALL "
                "WHERE page_id = %s AND row_start BETWEEN %s AND %s", (HERO, *when))
    added = {r[0] for r in cur.fetchall()}
    cur.execute("SELECT to_place FROM place_link FOR SYSTEM_TIME ALL "
                "WHERE page_id = %s AND row_end BETWEEN %s AND %s", (HERO, *when))
    removed = {r[0] for r in cur.fetchall()}
    assert added == {"Hennalan vankileiri", "Hämeenlinnan vankileiri", "Riihimäen vankileiri",
                     "Suomenlinnan vankileiri", "Tampereen vankileiri"}
    assert removed == {"Tampere", "Suomenlinna"}


@needs_places
@pytest.mark.parametrize("path", [
    "/api/years", "/api/captions",
    "/api/heat?year=2018&metric=knowledge", "/api/heat?year=2007&metric=activity",
    "/api/heat?year=2007&metric=controversy", "/api/heat?year=2013&metric=rewritten",
    "/api/arcs?year=2014", "/api/arcs?year=2014&all=1", f"/api/arcs?year=2014&page={HERO}",
    "/api/place/Tampere?date=2010-01-01", "/api/place/Helsinki",
    f"/api/article/{HERO}?date=2010-01-01", f"/api/article/{HERO}",
])
def test_place_routes_answer_with_their_sql(client, path):
    r = client.get(path)
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    assert "FROM" in body["sql"] and body["ms"] >= 0
    assert body.get("data") or body.get("blocks")


@needs_places
def test_article_as_of_is_the_version_of_that_day(client):
    a = client.get(f"/api/article/{HERO}?date=2010-01-01").json()
    assert a["rev_id"] == 7791638 and a["saved"].startswith("2009-12-29")
    assert "FOR SYSTEM_TIME AS OF" in a["sql"]
    assert a["oldid_url"].endswith("oldid=7791638")


@needs_places
def test_errors(client):
    assert client.get("/api/heat?year=2018&metric=nope").status_code == 400
    assert client.get("/api/heat?year=1999").status_code == 400
    assert client.get("/api/place/Atlantis").status_code == 404
    assert client.get(f"/api/article/{HERO}?date=2001-01-01").status_code == 404


SENTENCE_ROUTES = ["/api/articles", "/api/stats", "/api/map", f"/api/articles/{HERO}/as-of",
                   f"/api/articles/{HERO}/edit-wars", f"/api/articles/{HERO}/contested",
                   f"/api/articles/{HERO}/drift", f"/api/articles/{HERO}/revisions",
                   f"/api/articles/{HERO}/diff?from=2010-01-01", "/api/about?from=1917&to=1918"]


@needs_db
@pytest.mark.parametrize("path", SENTENCE_ROUTES)
def test_sentence_routes_never_crash(client, path):
    """Loaded: 200. Not loaded yet (no sentence tables): 503 that names the loader. Never a 500."""
    r = client.get(path)
    assert r.status_code in (200, 404, 503), r.text[:300]
    if r.status_code == 503:
        assert "Not loaded yet" in r.json()["detail"] or "out of date" in r.json()["detail"]


@needs_db
def test_health_and_docs(client):
    assert client.get("/api/health").json()["ok"] is True
    paths = client.get("/openapi.json").json()["paths"]
    assert "/api/heat" in paths and "/api/articles/{page_id}/edit-wars" in paths
