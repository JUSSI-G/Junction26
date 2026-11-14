# Verda process log (P3 keeps this live — required for the Verda challenge)

Why two machine types:
- **GPU instance** for scoring: every distinct sentence of every revision goes through Gemma
  (page 1150 alone: ~6,500 distinct sentences; all of dataset M: millions). Batch inference with
  vLLM's continuous batching — not a laptop job.
- **CPU instance** for MariaDB + API: the history queries are CPU/IO-bound and must stay up for
  the demo; no reason to pay for a GPU there.

## 1. GPU: Gemma with vLLM

```bash
# on the Verda GPU instance (fill in type: ___ , €/h: ___ )
pip install vllm
export HF_TOKEN=...            # Gemma licence accepted on Hugging Face
vllm serve google/gemma-3-12b-it --max-model-len 4096 --port 8000
# structured output (response_format json_schema) is on by default; check the flags of the
# installed vLLM version with `vllm serve --help` if requests come back as free text
```

Smoke test:

```bash
curl http://<gpu-ip>:8000/v1/models
```

## 2. Score

From any machine that reaches both MariaDB and the GPU:

```bash
SCORING_URL=http://<gpu-ip>:8000/v1 GEMMA_MODEL=google/gemma-3-12b-it \
  python -m scoring.score --backend llm --concurrency 64 --pages 1150   # hero first
SCORING_URL=... python -m scoring.score --backend llm --concurrency 128  # everything
```

`score.py` prints sentences/s and the invalid-JSON rate. Re-running only scores what is missing.

## 3. CPU: MariaDB + API + web

```bash
git clone <repo> && cd Junction26
INNODB_BUFFER_POOL=8G docker compose --profile app up -d --build        # MariaDB + API/web on :8000
docker compose run --rm app python -m ingest.download --all
docker compose run --rm app python -m ingest.replay --dataset large --workers $(nproc) --record
docker compose run --rm app python -m ingest.geo
docker compose run --rm app python -m ingest.event_time
docker compose run --rm app python -m scoring.score          # or with SCORING_URL for Gemma
docker compose run --rm app python -m db.benchmark --record
```

## 4. GPU: sentence embeddings (docs/contracts.md a)

`scripts/verda/embed_sentences.py`: dataset S (`data/s`), the 2,919 topics in fi + sv + en, split with
`ingest.sentences.text_sentences()`, embedded with BAAI/bge-m3 (sentence-transformers,
`normalize_embeddings=True`, same as `ingest/embed_cpu.py`) → `data/verda/sentences-{fi,sv,en}.parquet`
+ `embed_run.json` (device, timings, sentences/s). Device auto: CUDA (fp16, batch 256) if present, else CPU.

```bash
# on the Verda GPU instance
pip install -r scripts/verda/requirements.txt
# copy data/s/articles-{fi,sv,en}.parquet (37 MB) to the instance, then:
python scripts/verda/embed_sentences.py              # all 2,919 topics
```

**CPU test first (laptop, 2026-11-14):** `--pages "Sauli Niinistö,Suomen sisällissota"`, Intel i9-8950HK
(6 cores, torch 6 threads), torch 2.2.2 CPU, sentence-transformers 3.3.1, fp32, batch 32:
**2,145 sentences in 328 s = 6.5 sentences/s** (fi 1,112 · sv 306 · en 727; model load 74 s, wall 408 s).
Sentence counts equal Jussi's stage 1 split exactly (Niinistö 242/45/169, 1918 war 870/261/558), all
vectors 1024-dim with norm 1.0. For comparison Jussi's Windows PC did 13.7 sentences/s (16 threads).
At 6.5/s all 2,919 topics would take many hours on this laptop: that is the case for the GPU.

Intel Mac note: current torch has no Intel-Mac build (stops at 2.2.2) and transformers 5 needs torch ≥ 2.6,
so the laptop pins transformers 4.46 / sentence-transformers 3.3 / numpy < 2 / pyarrow < 20 (see
`scripts/verda/requirements.txt`). Same model weights, so `model` stays `bge-m3`; Ollama was not needed.

## 5. GPU: Gemma judges sentence pairs (docs/contracts.md b)

`scoring/judge_pairs.py`: for each Finnish sentence, its **mutual-best** sv and en match (cosine distance
≤ 0.418, Jussi's stage-1 threshold) from `data/verda/sentences-*.parquet`; Gemma labels each pair
same / contradiction / framing / partial with a one-line reason and both tones, via
`response_format: json_schema` (vLLM guided decoding; `reason` comes first in the schema so the model
explains before it labels). Endpoint from `.env`: `SCORING_URL`, `SCORING_API_KEY`, `GEMMA_MODEL`.

```bash
# Verda: vllm serve google/gemma-3-12b-it --max-model-len 4096 ; laptop reaches it by SSH tunnel
python -m scoring.judge_pairs --topics Q29207,Q211855 --concurrency 32 --gpu "A100 80GB" --eur-per-hour 2.159
```

**Hero run (2026-11-14):** Verda **A100 80GB, €2.159/h, vLLM 0.33**, google/gemma-3-12b-it, from the
laptop over an SSH tunnel, concurrency 32. Start **21:05:22**, end **21:05:59 EET**.
- **430 pairs** (Niinistö fi–sv 26, fi–en 84; 1918 war fi–sv 79, fi–en 241), all judged,
  **0 invalid JSON** (0 / 430 responses), 0 failures.
- **11.6 pairs/s**; 170k prompt + 30k output tokens = 5,400 tokens/s.
- **Cost of the run: 37 s × €2.159/h = €0.022** (≈ €0.05 per 1,000 pairs). The instance is billed for
  its whole uptime, not per request: at this speed the GPU is idle most of the time unless the job is big.
- Labels: sv partial 81 · framing 11 · contradiction 10 · same 3; en partial 264 · framing 31 ·
  contradiction 22 · same 8. "partial" dominates: two different-language editions rarely say exactly the
  same thing in one sentence.
- Quality, read by hand: many "contradictions" are real (orphans 20,000 vs 15,000; Viipuri 7,000 vs
  15,000 Reds; Seraphim collar 2014 vs 2016) but some are wrong pairings (different elections) or a
  different scope read as a disagreement. Measured on 30 hand-labelled pairs: `scoring/eval/pairs_labels.csv`,
  `python -m scoring.eval_pairs`.
- **Accuracy against 30 hand-labelled pairs** (stratified by Gemma's label: 8 contradiction, 8 framing,
  4 same, 10 partial; labeller did not see Gemma's label): **60 % on the 4 labels** (18/30; also 60 %
  when the labeller's second-choice label is accepted), **70 %** on "problem (contradiction/framing) or not".
  - contradiction: precision **3/8**, recall **3/3**. Gemma finds the real ones but over-flags: different
    estimates or scopes (8,000 vs 10,000 men; battle deaths vs all deaths; 40,000 vs 39,000 paroled)
    become "contradictions".
  - framing: precision 4/8, recall 4/4. same: precision 4/4, recall 4/9 (too strict: a missing
    "Finnish media" or country name makes it "partial").
  - So contradictions are **candidates for an editor to check**, not verdicts: which fits the tool
    (a human edits). 30 pairs is a small sample; the stratification also inflates the recall estimates.
  - Next steps if time: give Gemma the neighbouring sentences as context, a second "is this really a
    contradiction?" pass, or gemma-3-27b-it on the same A100.
**v2 run, "claims first" (2026-11-14):** same A100 80GB / vLLM 0.33 / gemma-3-12b-it, concurrency 32.
Start **21:31:38**, end **21:32:47 EET** (68.8 s). Schema now has `fi_claim`, `other_claim`,
`same_specific_fact` before the label; prompt rules: contradiction only for the same specific fact
that clearly disagrees, moderate (< 25 %) estimate differences = partial, wording / naming / minor
extra detail = same (examples in the prompt deliberately not taken from the 30 labelled pairs).
Code also downgrades contradiction → partial when `same_specific_fact` is false: **fired 0 times**.
- 430 pairs, 0 invalid JSON, **6.3 pairs/s** (more output tokens per pair), **€0.041**.
- Labels: sv same 43 · partial 57 · framing 3 · contradiction 2; en same 179 · partial 133 · framing 9 ·
  contradiction 4 (v1: 11 same, 32 contradiction, 42 framing in total).
- On the same 30 labels (v1 → v2): contradiction precision **3/8 → 2/3**, recall 3/3 → 2/3;
  framing precision 4/8 → 1/1 but recall **4/4 → 1/4**; same precision 4/4 → 8/20, recall 4/9 → 8/9;
  partial 7/10 → 4/6, recall 7/14 → 4/14. Accuracy **60 % → 50 %**; problem-vs-not 70 % → 83 %.
- Reading: the rule fixed over-flagging but over-corrected toward "same" (9 of the 14 human
  "partial" and 3 of 4 "framing" became "same"). Remaining false contradictions: two different
  elections (37 % vs 62.7 %) and battle deaths vs all deaths, both with `same_specific_fact` wrongly
  true, so the 12B model's scope judgement is the weak point. Contradiction precision 67 % < the 75 %
  target → next: **gemma-3-27b-it**.
- Note: the 30 pairs informed the new rules, so they are not a clean test any more. **Held-out set:
  20 new pairs** in `scoring/eval/pairs_test.csv` (stratified by v2 label, excluding the 30, Gemma's
  label hidden).
- Prompt iteration: one smoke test of 8 pairs called "leader until 2001" vs "succeeded in 2001" a
  contradiction; added "first ask whether both could be true at the same time". It still does: noted.

## Log

| Time | What | Machine | Result |
|---|---|---|---|
| 2026-11-14 17:57 | embed_sentences.py, 2 hero topics (CPU test) | laptop i9-8950HK, CPU | 2,145 sentences, 6.5 sentences/s |
| 2026-11-14 21:05 | judge_pairs.py, 2 hero topics, 430 pairs | Verda A100 80GB, vLLM 0.33, gemma-3-12b-it | 11.6 pairs/s, 0 % invalid JSON, €0.022 |
| 2026-11-14 21:31 | judge_pairs.py v2 (claims first), same 430 pairs | Verda A100 80GB, vLLM 0.33, gemma-3-12b-it | 6.3 pairs/s, 0 % invalid JSON, €0.041 |

## Throughput & cost (→ docs/numbers.md and the pitch)

| Model | GPU | Sentences/s | €/h | €/1k sentences | All of dataset M (est.) | All fi-Wikipedia (est.) |
|---|---|---|---|---|---|---|
| | | | | | | |

| Job | Model | GPU | Throughput | €/h | €/1k items |
|---|---|---|---|---|---|
| pair judgements | gemma-3-12b-it (vLLM 0.33) | A100 80GB | 11.6 pairs/s (concurrency 32) | 2.159 | 0.05 |
| sentence embeddings (CPU test) | bge-m3 | none (laptop i9) | 6.5 sentences/s | – | – |
