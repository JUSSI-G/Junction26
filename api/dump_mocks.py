"""Write web/mocks/*.json from the real API, so the frontend can run without a backend
(npm run dev:mock). Uses FastAPI's TestClient: the mocks are exactly the contract's shapes.

    python -m api.dump_mocks                 # the synthetic demo article (make ingest DATASET=demo)
    python -m api.dump_mocks --page 1150     # the real Suomen sisällissota
"""
from __future__ import annotations

import argparse
import json
import sys

from fastapi.testclient import TestClient

from api.main import app
from common.db import ROOT
from ingest.synthetic import DEMO_PAGE

OUT = ROOT / "web" / "mocks"


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--page", type=int, default=DEMO_PAGE)
    a = ap.parse_args()
    c = TestClient(app)
    p = a.page

    def get(path):
        r = c.get("/api" + path)
        r.raise_for_status()
        return r.json()

    revs = get(f"/articles/{p}/revisions")
    mid = revs[len(revs) // 2]["timestamp"]
    wars = get(f"/articles/{p}/edit-wars?limit=40")
    contested = get(f"/articles/{p}/contested")
    top = max(contested, key=lambda s: s["rewrites"] + 2 * s["lives"])
    mocks = {
        "articles": [x for x in get("/articles?limit=50") if x["page_id"] == p],
        "as_of": get(f"/articles/{p}/as-of"),
        "diff": get(f"/articles/{p}/diff?from={mid}"),
        "contested": contested,
        "edit_wars": wars,
        "revisions": revs,
        "revision": get(f"/revisions/{revs[-1]['rev_id']}"),
        "sentence_history": get(f"/articles/{p}/sentences/{top['hash']}/history"),
        "stats": get("/stats?refresh=true"),
        "about": get(f"/articles/{p}/about?from=1917&to=1918"),
        "about_all": get("/about?from=1917&to=1918&date=2012-01-01"),
        "map": get("/map?refresh=true"),
        "map_near": get("/map/near?lat=60.17&lon=24.94&deg=1"),
    }
    for b in ("month", "quarter", "year"):
        mocks[f"drift_{b}"] = get(f"/articles/{p}/drift?bucket={b}")
        mocks[f"term_drift_{b}"] = get(f"/articles/{p}/term-drift?bucket={b}")
    OUT.mkdir(parents=True, exist_ok=True)
    for name, data in mocks.items():
        (OUT / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Wrote {len(mocks)} mocks for page {p} to {OUT}")


if __name__ == "__main__":
    main()
