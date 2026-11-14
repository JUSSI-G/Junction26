"""The editor routes against the loaded database, checked field by field against docs/contracts.md (c)
and the shapes of web/mocks/worklist.json and compare.json."""
from __future__ import annotations

import json

import pymysql
import pytest
from fastapi.testclient import TestClient

from api.main import app
from common.db import ROOT, connect


def _ready() -> bool:
    try:
        c = connect(dict_rows=False)
    except pymysql.err.OperationalError:
        return False
    try:
        with c.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM article_divergence")
            return cur.fetchone()[0] > 0
    except pymysql.err.ProgrammingError:
        return False
    finally:
        c.close()


pytestmark = pytest.mark.skipif(not _ready(), reason="article_divergence not built (python -m db.build_divergence)")
MOCKS = ROOT / "web" / "mocks"
STATUSES = {"match", "missing_sv", "missing_en", "only_sv", "only_en"}


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def test_worklist_matches_the_contract(client):
    r = client.get("/api/worklist?limit=3000")
    assert r.status_code == 200
    body = r.json()
    assert "FROM article_divergence" in body["sql"]
    mock_keys = set(json.loads((MOCKS / "worklist.json").read_text(encoding="utf-8"))["data"][0])
    rows = body["data"]
    assert rows and all(set(x) == mock_keys for x in rows)
    assert all(set(x["titles"]) == {"fi", "sv", "en"} for x in rows)
    assert all(set(x["missing_in_fi"]) == {"sv", "en"} for x in rows)
    scores = [x["score"] for x in rows]
    assert scores == sorted(scores, reverse=True) and 0 <= min(scores) and max(scores) <= 1
    flagged = client.get("/api/worklist?limit=3000&include_flagged=1").json()["data"]
    assert len(flagged) == 2919 and len(rows) < 2919          # different-subject topics left out


@pytest.mark.parametrize("q", ["Q29207", "Q211855"])
def test_compare_hero_matches_the_contract(client, q):
    r = client.get(f"/api/compare/{q}")
    assert r.status_code == 200
    body = r.json()
    mock = json.loads((MOCKS / "compare.json").read_text(encoding="utf-8"))
    assert set(body["topic"]) == set(mock["topic"]) and set(body["scores"]) == {"fi_sv", "fi_en", "sv_en"}
    assert body["topic"]["edit_urls"]["en"].endswith("&action=edit")
    assert "VEC_DISTANCE_COSINE" in body["sql"] and "lang_pair" in body["sql"]
    rows = body["rows"]
    assert rows and {x["status"] for x in rows} <= STATUSES
    fi = [x["fi"]["sent_no"] for x in rows if x["fi"]]
    assert fi == sorted(fi) and fi == list(range(len(fi)))      # every Finnish sentence, in order
    for x in rows:
        assert set(x) == {"fi", "sv", "en", "covered_by", "status", "judgements"}
        assert set(x["covered_by"]) == {"sv", "en"}
        for lang in ("sv", "en"):
            here = x[lang] or x["covered_by"][lang]
            assert x[lang] is None or x["covered_by"][lang] is None       # aligned OR covered, not both
            if here and x["fi"]:
                assert here["distance"] <= 0.418          # shown rounded to 3 decimals
        if x["status"] == "match":
            assert (x["sv"] or x["covered_by"]["sv"]) and (x["en"] or x["covered_by"]["en"])
        if x["status"] == "missing_en":
            assert x["en"] is None and x["covered_by"]["en"] is None
        if x["status"].startswith("only_"):
            assert x["fi"] is None and x[x["status"][5:]] is not None
    for lang in ("sv", "en"):                                     # each sv / en sentence at most once
        seen = [x[lang]["sent_no"] for x in rows if x[lang]]
        assert len(seen) == len(set(seen))


def test_compare_without_sentences_says_so(client):
    q = client.get("/api/worklist?limit=3000").json()["data"]
    no_sentences = next(x["wikidata_id"] for x in q if x["missing_en"] is None)
    body = client.get(f"/api/compare/{no_sentences}").json()
    assert body["rows"] == [] and "not computed yet" in body["note"]
    assert body["scores"]["fi_en"] is not None


def test_compare_unknown_topic_is_404(client):
    assert client.get("/api/compare/Q1").status_code == 404


def test_lang_lines_for_the_globe(client):
    body = client.get("/api/lang-lines").json()
    rows = body["data"]
    assert "FROM article_divergence" in body["sql"] and len(rows) > 800
    assert {r["located_by"] for r in rows} <= {"page_place", "article_geo", "inferred"}
    by_id = {r["wikidata_id"]: r for r in rows}
    assert by_id["Q211855"]["located_by"] == "page_place"
    assert by_id["Q29207"]["place"] == "Salo"                     # inferred: his most-linked place
    flagged = {x["wikidata_id"] for x in client.get("/api/worklist?limit=3000&include_flagged=1").json()["data"]}
    kept = {x["wikidata_id"] for x in client.get("/api/worklist?limit=3000").json()["data"]}
    assert not (set(by_id) & (flagged - kept))                     # different-subject topics hidden
    assert all(0 <= r["fi_sv"] <= 2 and 0 <= r["fi_en"] <= 2 for r in rows)


def test_missing_counts_agree_between_worklist_and_compare(client):
    """missing_en in the worklist = the compare rows with status missing_en (nothing within 0.418)."""
    work = {x["wikidata_id"]: x for x in client.get("/api/worklist?limit=3000").json()["data"]}
    for q in ("Q29207", "Q211855"):
        rows = client.get(f"/api/compare/{q}").json()["rows"]
        assert sum(r["status"] == "missing_en" for r in rows) == work[q]["missing_en"]
        assert sum(r["status"] == "only_en" for r in rows) == work[q]["missing_in_fi"]["en"]


def test_subject_override(client):
    """db/subject_overrides.tsv: Maunu Eerikinpojan maanlaki is the same law in every language."""
    kept = {x["wikidata_id"] for x in client.get("/api/worklist?limit=3000").json()["data"]}
    assert "Q339275" in kept
