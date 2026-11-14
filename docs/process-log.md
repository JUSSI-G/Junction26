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

## Log

| Time | What | Machine | Result |
|---|---|---|---|
| | | | |

## Throughput & cost (→ docs/numbers.md and the pitch)

| Model | GPU | Sentences/s | €/h | €/1k sentences | All of dataset M (est.) | All fi-Wikipedia (est.) |
|---|---|---|---|---|---|---|
| | | | | | | |
