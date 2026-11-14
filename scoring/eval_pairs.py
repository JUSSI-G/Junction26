r"""Hand-labelled check of Gemma's pair judgements (scoring/judge_pairs.py).

    python -m scoring.eval_pairs --sample 30     # write scoring/eval/pairs_labels.csv (blank `label`)
    python -m scoring.eval_pairs                 # after labelling: accuracy against Gemma

The sample is stratified by Gemma's label (so rare labels are represented), seeded, and the CSV does
**not** contain Gemma's label, so the human labeller is not anchored. Labels: same, contradiction,
framing, partial (docs/contracts.md b).
"""
from __future__ import annotations

import argparse
import csv
import random
import sys
from collections import Counter
from pathlib import Path

import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[1]
DETAIL = ROOT / "data" / "verda" / "judgements-detail.csv"
JUDGEMENTS = ROOT / "data" / "verda" / "judgements.parquet"
LABELS_CSV = ROOT / "scoring" / "eval" / "pairs_labels.csv"
LABELS = ["same", "contradiction", "framing", "partial"]
KEY = ("wikidata_id", "fi_sent_no", "other_lang", "other_sent_no")
FIELDS = ["n", *KEY, "distance", "fi_text", "other_text", "label", "notes"]
# How many of each Gemma label to sample (rare labels oversampled; the rest is "partial").
QUOTA = {"contradiction": 8, "framing": 8, "same": 4}


def key(r: dict) -> tuple:
    return (r["wikidata_id"], int(r["fi_sent_no"]), r["other_lang"], int(r["other_sent_no"]))


def sample(n: int, seed: int) -> None:
    if LABELS_CSV.exists() and any(r.get("label") for r in csv.DictReader(open(LABELS_CSV, encoding="utf-8"))):
        sys.exit(f"{LABELS_CSV} already has labels; not overwriting")
    rows = list(csv.DictReader(open(DETAIL, encoding="utf-8")))
    rng = random.Random(seed)
    by = {lab: [r for r in rows if r["label"] == lab] for lab in LABELS}
    picked = []
    for lab, q in QUOTA.items():
        picked += rng.sample(by[lab], min(q, len(by[lab])))
    picked += rng.sample(by["partial"], n - len(picked))
    rng.shuffle(picked)
    LABELS_CSV.parent.mkdir(parents=True, exist_ok=True)
    with open(LABELS_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
        w.writeheader()
        for i, r in enumerate(picked, 1):
            w.writerow({**r, "n": i, "label": "", "notes": ""})
    print(f"wrote {len(picked)} pairs to {LABELS_CSV} (fill in `label`: {' / '.join(LABELS)})")


def evaluate() -> None:
    human = {key(r): r for r in csv.DictReader(open(LABELS_CSV, encoding="utf-8")) if r["label"].strip()}
    if not human:
        sys.exit(f"no labels in {LABELS_CSV} yet")
    bad = {r["label"] for r in human.values()} - set(LABELS)
    if bad:
        sys.exit(f"unknown labels: {bad}")
    gemma = {key(r): r for r in pq.read_table(JUDGEMENTS).to_pylist()}
    pairs = [(h["label"].strip(), gemma[k]["label"]) for k, h in human.items() if k in gemma]
    n = len(pairs)
    acc = sum(h == g for h, g in pairs) / n
    print(f"{n} hand-labelled pairs · model {next(iter(gemma.values()))['model']}")
    print(f"accuracy (4 labels): {acc:.0%}  ({sum(h == g for h, g in pairs)}/{n})")
    # Coarser question the editor cares about: is there a problem (contradiction/framing) or not?
    prob = lambda x: x in ("contradiction", "framing")  # noqa: E731
    acc2 = sum(prob(h) == prob(g) for h, g in pairs) / n
    print(f"accuracy (problem = contradiction|framing vs not): {acc2:.0%}")
    print("\nper Gemma label: precision (human agrees) · per human label: recall (Gemma finds it)")
    for lab in LABELS:
        g = [h for h, gl in pairs if gl == lab]
        h = [gl for hl, gl in pairs if hl == lab]
        p = f"{sum(x == lab for x in g)}/{len(g)}" if g else "–"
        r = f"{sum(x == lab for x in h)}/{len(h)}" if h else "–"
        print(f"  {lab:<14} precision {p:>6}   recall {r:>6}")
    print("\nconfusion (rows = human, columns = Gemma):")
    c = Counter(pairs)
    print(" " * 15 + "".join(f"{lab[:8]:>10}" for lab in LABELS))
    for hl in LABELS:
        print(f"  {hl:<13}" + "".join(f"{c[(hl, gl)]:>10}" for gl in LABELS))


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sample", type=int, help="write a new labelling sample of N pairs")
    ap.add_argument("--seed", type=int, default=1918)
    a = ap.parse_args()
    sample(a.sample, a.seed) if a.sample else evaluate()


if __name__ == "__main__":
    main()
