# Contracts between Jussi (database, API) and Kristian (Verda, Gemma, React)

Fixed on 2026-11-14. **Change a format only by editing this file in the same commit**, with a line
under "Changes" at the bottom. Mocks of (c) are in `web/mocks/worklist.json` and
`web/mocks/compare.json`. The mocks hold realistic **fake** data for Sauli Niinistö (Q29207): the
sentences are plausible, but the numbers, distances and judgements are made up.

Conventions for all three:
- `lang` is `fi`, `sv` or `en`.
- `page_id` is the page id **in that language's Wikipedia** (fi 1137, sv 119870 and en 1042690 are
  all Niinistö). Topics are joined across languages by `wikidata_id` (`"Q29207"`).
- Sentences are numbered from 0 per (lang, page_id), in text order: `sent_no`.
- Sentences are split with **`ingest.sentences.text_sentences(text)`** on dataset S's `text`, by both
  of us, so the numbers agree. `sent_no` = the index in the list it returns. (S text is Markdown-like
  plain text, not wikitext: the function drops `#` headings and `|` table rows, strips `- ` list
  markers, then uses the same splitter and filters as `sentences()`: at least 3 words, repeats within
  an article kept once.)
- **Distances are cosine distances** (`VEC_DISTANCE_COSINE`, 0 = same direction, 2 = opposite),
  between bge-m3 embeddings. Lower = more similar.

## a) Sentence embeddings (Kristian produces on Verda; Jussi imports into `lang_sentence`)

`data/verda/sentences-{lang}.parquet`, one file per language, one row per sentence:

| column | type | |
|---|---|---|
| `lang` | string | `fi` / `sv` / `en` |
| `page_id` | int32 | that language's page id (dataset S `page_id`) |
| `wikidata_id` | string | e.g. `Q29207` |
| `sent_no` | int32 | 0-based, text order |
| `text` | string | the sentence as split, before normalisation |
| `embedding` | list<float32>, length 1024 | bge-m3 dense vector, **L2-normalised** |
| `model` | string | `bge-m3` |

Scope: every sentence of the 2,919 topics that exist in all three languages.

## b) Gemma judgements (Kristian produces; Jussi imports into `pair_judgement`)

`data/verda/judgements.parquet`, one row per judged pair:

| column | type | |
|---|---|---|
| `wikidata_id` | string | |
| `fi_sent_no` | int32 | the Finnish sentence |
| `other_lang` | string | `sv` / `en` |
| `other_sent_no` | int32 | its matched sentence in `other_lang` |
| `label` | string | `same` \| `contradiction` \| `framing` \| `partial` |
| `reason` | string | one English sentence |
| `tone_fi` | string | `neutral` \| `loaded` \| `partisan` |
| `tone_other` | string | `neutral` \| `loaded` \| `partisan` |
| `fi_claim` | string | the specific fact the Finnish sentence states, in a few English words |
| `other_claim` | string | the same for the other sentence |
| `same_specific_fact` | bool | both state a value for the very same thing (same quantity / event / date / name, same scope) |
| `model` | string | e.g. `google/gemma-3-12b-it` |

Labels: `same` = the same claim (differences in wording, naming or a minor extra detail only);
`contradiction` = **only if `same_specific_fact` is true** and the two clearly disagree on that fact
(number, date, name); `framing` = the same fact told with a different slant or tone; `partial` = they
overlap only partly, or estimates / ranges for the same quantity differ moderately (< 25 %).
`label = contradiction` with `same_specific_fact = false` never occurs (enforced in code).

## c) API (Jussi builds; Kristian's React view uses it)

Both responses carry `sql`: the MariaDB query behind the view, for the SQL drawer.

### `GET /api/worklist?limit=50`

```json
{"sql": "SELECT … FROM article_divergence …",
 "data": [{"wikidata_id": "Q29207",
           "titles": {"fi": "Sauli Niinistö", "sv": "Sauli Niinistö", "en": "Sauli Niinistö"},
           "fi_page_id": 1137,
           "score": 0.81,
           "fi_sv": 0.212, "fi_en": 0.168,
           "missing_sv": 41, "missing_en": 23,
           "contradictions": 2,
           "edit_war_score": 0.74}]}
```
- Ordered by `score` (descending); `score` is in 0..1, higher = needs an editor more.
- `fi_sv`, `fi_en`: whole-article cosine distance between the language versions.
- `missing_sv` / `missing_en`: Finnish sentences with no match above the threshold in that language.
- `contradictions`: pairs that Gemma labelled `contradiction`.
- `edit_war_score`: 0..1, from the Finnish article's history (reverts, sentences that came back).
- Any number can be `null` when that stage has not run yet.

### `GET /api/compare/{wikidata_id}`

```json
{"sql": "…",
 "topic": {"wikidata_id": "Q29207",
           "titles": {"fi": "…", "sv": "…", "en": "…"},
           "urls": {"fi": "https://fi.wikipedia.org/wiki/…", "sv": "…", "en": "…"},
           "edit_urls": {"fi": "https://fi.wikipedia.org/w/index.php?title=…&action=edit", "sv": "…", "en": "…"}},
 "scores": {"fi_sv": 0.212, "fi_en": 0.168, "sv_en": 0.143},
 "rows": [{"fi": {"sent_no": 0, "text": "…"},
           "sv": {"sent_no": 0, "text": "…", "distance": 0.11},
           "en": {"sent_no": 0, "text": "…", "distance": 0.09},
           "status": "match",
           "judgements": [{"lang": "en", "label": "same", "reason": "…", "model": "…"}]}]}
```
- `rows` follow the Finnish text order. A sentence that exists only in sv or en gets a row of its own
  (`fi: null`), placed after the Finnish sentence it is nearest to.
- `status`:

| status | meaning |
|---|---|
| `match` | the fi sentence has a match in sv **and** en |
| `missing_sv` | the fi sentence has no match in sv (`sv: null`) |
| `missing_en` | no match in en (`en: null`) |
| `only_sv` / `only_en` | a sv / en sentence that no fi sentence matches (`fi: null`) |

  A fi sentence missing from **both** languages has `status: "missing_en"` and both `sv` and `en`
  are null.
- `judgements` is `[]` until Gemma has run; `lang` says which pair (fi–sv or fi–en) it judges.

## Changes

- 2026-11-14: first version.
- 2026-11-14: sentences are split with `text_sentences()` (new, for S's Markdown-like text), not
  `sentences()` / `split_sentences()`.
- 2026-11-14: (b) gains `fi_claim`, `other_claim`, `same_specific_fact` (written by Gemma before the
  label); labels tightened: contradiction only for the same specific fact, moderate estimate
  differences are `partial`, wording / naming / minor extra detail is `same`. Labels unchanged.
