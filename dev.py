"""Cross-platform task runner (Windows has no make). `make X` calls `python dev.py X`.

    python dev.py db                      # MariaDB in Docker + tables
    python dev.py ingest                  # load DATASET (env, default demo) — see .env.example
    python dev.py ingest small 1150       # dataset + optional page ids
    python dev.py score                   # Gemma if SCORING_URL is set, else keyword baseline
    python dev.py api                     # http://localhost:8000/docs
    python dev.py web                     # http://localhost:5173 (proxies /api)
    python dev.py web-mock                # frontend on web/mocks only, no backend
    python dev.py mocks                   # regenerate web/mocks from the API
    python dev.py test
    python dev.py demo                    # db + demo data + scores + build web + API on :8000
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PY = sys.executable
NPM = shutil.which("npm") or "npm"


def sh(*cmd: str, cwd: Path = ROOT) -> None:
    print("$", " ".join(cmd), flush=True)
    r = subprocess.run(list(cmd), cwd=cwd)
    if r.returncode:
        sys.exit(r.returncode)


def db() -> None:
    sh("docker", "compose", "up", "-d", "--wait")
    sh(PY, "-m", "common.schema")


def ingest(dataset: str | None = None, pages: str | None = None) -> None:
    dataset = dataset or os.environ.get("DATASET", "demo")
    if dataset in ("small", "large"):
        sh(PY, "-m", "ingest.download", "--all")
    elif dataset == "medium":
        sh(PY, "-m", "ingest.download", "01", "02", "03", "04")
    cmd = [PY, "-m", "ingest.replay", "--dataset", dataset, "--record"]
    if pages:
        cmd += ["--pages", pages]
    if dataset in ("medium", "large"):
        cmd += ["--workers", str(max(1, (os.cpu_count() or 2) - 1))]
    sh(*cmd)
    sh(PY, "-m", "ingest.stats")           # globe summary for pages loaded before article_stats
    sh(PY, "-m", "ingest.event_time")      # bitemporal periods for the new sentences


def web_build() -> None:
    if not (ROOT / "web" / "node_modules").exists():
        sh(NPM, "install", "--no-audit", "--no-fund", cwd=ROOT / "web")
    sh(NPM, "run", "build", cwd=ROOT / "web")


TASKS = {
    "db": db,
    "ingest": ingest,
    "score": lambda: sh(PY, "-m", "scoring.score"),
    "api": lambda: sh(PY, "-m", "uvicorn", "api.main:app", "--reload", "--port", "8000"),
    "web": lambda: sh(NPM, "run", "dev", cwd=ROOT / "web"),
    "web-mock": lambda: sh(NPM, "run", "dev:mock", cwd=ROOT / "web"),
    "web-build": web_build,
    "mocks": lambda: sh(PY, "-m", "api.dump_mocks"),
    "test": lambda: sh(PY, "-m", "pytest", "-q"),
    "demo": lambda: (db(), ingest("demo"), sh(PY, "-m", "scoring.score", "--backend", "heuristic"),
                     web_build(), sh(PY, "-m", "uvicorn", "api.main:app", "--port", "8000")),
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in TASKS:
        print(__doc__)
        sys.exit(1)
    TASKS[sys.argv[1]](*sys.argv[2:])
