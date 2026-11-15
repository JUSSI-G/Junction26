# AikaKone

**Finnish, Swedish and English Wikipedia on Finland's history: where the versions differ, and where
editors fight.** A tool for Wikipedia editors.

Junction 2026 · MariaDB *Wikipedia Through Time* (vector search **and** system-versioned tables) ·
Best Use of Gemma · Verda Compute Track

1. **Worklist:** 2,919 articles that exist in all three languages, ranked by how differently the
   versions tell it, what content is missing, Gemma's possible contradictions, and edit wars in the
   Finnish history. Narrow it with a **semantic search** (bge-m3 + `VEC_DISTANCE`, so it also finds
   articles that never use the word), **topic chips** (a Finnish category and its subcategories,
   `WITH RECURSIVE`) or a title search.
2. **Article page:**
   - **Languages:** fi / sv / en sentence by sentence (bge-m3 sentence vectors, mutual best matches),
     with Gemma's possible contradictions on top, the ones two models agree on first.
   - **Edit wars:** the Finnish article's history from system-versioned sentences: sentences that
     were removed and came back, how contested each sentence is, the article as of any date
     (`FOR SYSTEM_TIME AS OF`).
   - **"Edit in Wikipedia":** opens Wikipedia's own editor. A human makes the edit.
3. **Map:** the same articles at their places; a click draws lines to the 10 most similar articles.

Every view shows its MariaDB SQL (the **SQL** button, bottom left).

## Run it

Needs MariaDB 11.8+ (vector support), Python 3.11+, Node 18+. Settings in `.env` (see `.env.example`).

```bash
pip install -r requirements.txt
npm --prefix web install && npm --prefix web run build
python -m uvicorn api.main:app --port 8000      # http://localhost:8000
```

## Data pipeline

| Step | Command |
|---|---|
| Dataset M (19,742 Finnish articles, 862,076 versions, system-versioned) | `python -m ingest.load_parquet` |
| Sentence history for the edit-war views | `python -m ingest.replay --sentences-only` |
| Dataset S (current fi / sv / en text + bge-m3 article vectors) | `python -m ingest.load_lang` |
| Category tree for the topic chips | `python -m ingest.load_categories` |
| Sentence vectors (bge-m3 on a Verda GPU, 358,553 sentences) | `python -m ingest.load_verda_sentences` |
| Sentence matching (mutual best matches, threshold 0.418) | `python -m db.lang_match --workers 8` |
| Gemma judgements (27B on Verda, 12B second opinion) | `python -m ingest.load_judgements` |
| Map positions | `python -m db.build_topic_place` |
| Worklist scores | `python -m db.build_divergence` |
| Map coastlines (Natural Earth 1:10m) | `python scripts/make_world_map.py <countries.geojson> <lakes.geojson>` |

Tests: `python -m pytest`. Demo run with screenshots and timings: `cd web && npm run demo-flow`.

## Docs

- [NOTES.md](NOTES.md): the build log, with every decision and measured number
- [docs/process-log.md](docs/process-log.md): the Verda runs (GPU, time, cost)
- [docs/contracts.md](docs/contracts.md): the data formats between the team's parts
- [docs/decisions.md](docs/decisions.md), [docs/numbers.md](docs/numbers.md)

## Licence

Wikipedia text and anything derived from it: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/),
credit Wikipedia and its authors. Map data: Natural Earth (public domain).
