"""Plan §8: the synthetic A→X→A article, loaded both ways, must give these answers.

Needs MariaDB (make db). Uses a separate database, wiki_test, which it drops and recreates.
"""
from __future__ import annotations

import os

import pymysql
import pytest

from api import history as H
from common.db import connect
from ingest import synthetic
from ingest.event_time import fill as fill_event_time
from ingest.replay import load

TEST_DB = os.environ.get("TEST_DB_NAME", "wiki_test")


def _db_up() -> bool:
    try:
        connect(database="").close()
        return True
    except pymysql.err.OperationalError:
        return False


pytestmark = pytest.mark.skipif(not _db_up(), reason="MariaDB not reachable (make db)")


@pytest.fixture(scope="module", params=["bulk", "replay"])
def conn(request):
    load("demo", None, mode=request.param, database=TEST_DB, reset=True, quiet=True)
    c = connect(TEST_DB, autocommit=True)
    fill_event_time(c, quiet=True)
    yield c
    c.close()


ABC = synthetic.ABC_PAGE
DEMO = synthetic.DEMO_PAGE


def texts(snapshot):
    return [s["text"] for s in snapshot["sentences"]]


def test_as_of(conn):
    a, b, c, x = "Lause A on ensimmäinen.", "Lause B on kiistelty.", "Lause C on viimeinen.", "Lause B on kiistanalainen."
    assert texts(H.as_of(conn, ABC, "2011-01-01")) == [a, b, c]
    assert texts(H.as_of(conn, ABC, "2013-01-01")) == [a, x, c]
    assert texts(H.as_of(conn, ABC, "2015")) == [a, b, c]
    assert H.as_of(conn, ABC, "2013-01-01")["editor"] == "u2"


def test_before_creation_is_404(conn):
    with pytest.raises(H.NotFound):
        H.as_of(conn, ABC, "2009-12-31")


def test_edit_wars(conn):
    wars = H.edit_wars(conn, ABC)
    assert len(wars) == 1
    assert wars[0]["text"] == "Lause B on kiistelty." and wars[0]["lives"] == 2
    first, second = wars[0]["periods"]
    assert first["editor"] == "u1" and first["removed_by"] == "u2"
    assert first["to"].startswith("2012-01-01") and second["to"] is None


def test_contested(conn):
    rows = {r["text"]: r for r in H.contested(conn, ABC)}
    assert rows["Lause A on ensimmäinen."]["lives"] == 1
    assert rows["Lause B on kiistelty."]["lives"] == 2
    assert [r["position"] for r in H.contested(conn, ABC)] == [0, 1, 2]


def test_rewrite_chain(conn):
    # X replaced B in 2012 (similar wording), then B replaced X in 2014.
    rows = {r["text"]: r for r in H.contested(conn, ABC)}
    assert rows["Lause B on kiistelty."]["rewrites"] == 2
    chain = H.sentence_history(conn, ABC, rows["Lause B on kiistelty."]["hash"])
    assert [c["text"] for c in chain] == ["Lause B on kiistelty.", "Lause B on kiistanalainen.", "Lause B on kiistelty."]


def test_diff(conn):
    d = H.diff(conn, ABC, "2011-01-01", "2013-01-01")
    assert [s["text"] for s in d["added"]] == ["Lause B on kiistanalainen."]
    assert [s["text"] for s in d["removed"]] == ["Lause B on kiistelty."]
    assert d["kept"] == 2


def test_demo_vandalism_dropped_and_name_war(conn):
    wars = H.edit_wars(conn, DEMO, 50)
    assert not any("VALETTA" in w["text"] for w in wars)          # blanking filtered
    assert wars[0]["lives"] >= 6                                    # the name war tops the list
    assert "sisällissota" in wars[0]["text"] or "vapaussota" in wars[0]["text"]


def test_term_drift_tracks_the_name(conn):
    rows = H.term_drift(conn, DEMO, ["vapaussota", "sisällissota"], "year")
    by_year = {r["period"]: r["terms"] for r in rows}
    assert by_year["2004"]["vapaussota"] >= 1
    assert by_year["2020"]["sisällissota"] >= 1


def test_sweep_matches_as_of_snapshots(conn):
    """term_drift's +1/-1 sweep must agree with an AS OF snapshot taken at every period end."""
    for row in H.term_drift(conn, DEMO, ["sota"], "quarter"):
        end = row["period_end"]           # last second of the period
        try:
            snap = H.as_of(conn, DEMO, end)["sentences"]
        except H.NotFound:
            snap = []
        assert row["sentences"] == len(snap), row["period"]
        assert row["terms"]["sota"] == sum("sota" in s["text"].lower() for s in snap), row["period"]


def test_revisions_and_lookup(conn):
    revs = H.revisions(conn, ABC)
    assert [r["editor"] for r in revs] == ["u1", "u2", "u3"]
    r = H.revision(conn, revs[1]["rev_id"])
    assert r["page_id"] == ABC and r["until"].startswith("2014")


def test_bitemporal(conn):
    """System time x application time: what the article said on a date about events of some years."""
    early = H.about(conn, DEMO, "2004-06-01", 1918, 1918)
    assert early and all(s["event_from"] <= 1918 <= s["event_to"] for s in early)
    # The 2018 reconciliation sentence: about 2018, and only in the article from 2013 on.
    def about_2018(when):
        return [s["text"] for s in H.about(conn, DEMO, when, 2018, 2018)]
    assert not any("2018" in t for t in about_2018("2010-01-01"))
    assert any("muistovuonna" in t for t in about_2018("2020-01-01"))
    # And no 1918 sentence is "about" the 1600s.
    assert H.about(conn, DEMO, "2020-01-01", 1600, 1699) == []
    allw = H.about_all(conn, "2020-01-01", 1917, 1918)
    assert allw[0]["page_id"] == DEMO and allw[0]["sentences"] >= 3


def test_globe(conn):
    pts = {p["page_id"]: p for p in H.map_points(conn)}
    assert ABC not in pts                               # no coordinates -> not on the map
    demo = pts[DEMO]
    assert abs(demo["lat"] - 61.4978) < 0.01 and abs(demo["lon"] - 23.7608) < 0.01
    assert demo["returns"] > 0 and demo["contested"] == demo["returns"] + demo["reverts"]
    near = H.near(conn, 61.5, 23.8, 1.0)
    assert near[0]["page_id"] == DEMO and near[0]["km"] < 5
    assert H.near(conn, 0, 0, 1.0) == []


def test_stats(conn):
    s = H.stats(conn, "demo", runs=2)
    assert s["articles"] == 2 and s["revisions"] > 50
    assert set(s["query_ms"]) >= {"as_of", "edit_wars", "drift"}
