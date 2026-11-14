r"""Time every API endpoint against the running server (second call of each = warm).

    .venv\Scripts\python check_api.py            # http://127.0.0.1:8000
"""
import json, sys, time, urllib.parse, urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
SLOW_MS = 300
CALLS = [
    "/api/years",
    "/api/captions",
    "/api/heat?year=2018&metric=knowledge",
    "/api/heat?year=2007&metric=activity",
    "/api/heat?year=2007&metric=controversy",
    "/api/heat?year=2013&metric=rewritten",
    "/api/heat?year=2026&metric=knowledge&limit=20000",
    "/api/arcs?year=2014",
    "/api/arcs?year=2007&all=1",
    "/api/arcs?year=2018&all=1&limit=1500",
    "/api/arcs?year=2014&page=1150",
    "/api/place/Tampere?date=2010-01-01",
    "/api/place/Helsinki",
    "/api/place/Suomi?date=2018-12-31",
    "/api/place/Hennalan vankileiri?date=2015-01-01",
    "/api/article/1150?date=2010-01-01",
    "/api/article/1150",
]


def get(path):
    url = BASE + urllib.parse.quote(path, safe="/?=&")
    t = time.perf_counter()
    with urllib.request.urlopen(url, timeout=120) as r:
        body = r.read()
    return (time.perf_counter() - t) * 1000, body


slow = 0
print(f"{'endpoint':<52} {'total ms':>9} {'db ms':>8} {'rows':>6} {'KB':>7}")
for path in CALLS:
    get(path)
    ms, body = min((get(path) for _ in range(3)), key=lambda x: x[0])
    d = json.loads(body)
    rows = len(d["data"]) if isinstance(d.get("data"), list) else len(d.get("blocks", []))
    flag = "  SLOW" if ms > SLOW_MS else ""
    slow += ms > SLOW_MS
    print(f"{path:<52} {ms:9.1f} {d.get('ms', 0):8.1f} {rows:6} {len(body) / 1000:7.1f}{flag}")
    assert "FROM" in d["sql"]
print(f"\n{slow} endpoint(s) over {SLOW_MS} ms")
