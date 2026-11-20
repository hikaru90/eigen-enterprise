# Eigen Evals

DB-backed evaluation via **`/eval`** (dev only): ingest thoughts, optionally probe retrieval, apply edits, then judge answers.

## Run

```bash
npm run db:migrate && npm run db:rls
npm run eval              # smoke — one question from eval_qa
npm run eval -- --mode all
npm run eval -- --mode qa --qa-id qa_smoke_dinner
npm run eval -- --mode qa --qa-id qa_surgical_vats_phrenic_stapler
npm run eval -- --fresh-corpus   # wipe corpus tenant and re-ingest everything
npm run eval:reset-fixture -- --fixture ec_jonas_silence   # delete one corpus thought so next run re-captures it
```

Dev UI: `/eval` — manage the **Questions & answers** catalog. Use **Run** on a row to execute one question (`mode: qa`), or use the Runs tab for smoke/all. **Reset corpus & start** wipes the shared eval tenant before ingesting. **Stop run** cancels the in-process runner without restarting dev (finishes the current step, then exits).

## Persistent corpus

Each operator has one shared eval brain tenant (`eval-corpus-{operatorUserId}`). By default:

- **Thoughts are kept** across runs (no post-run wipe).
- **Captures are skipped** when a fixture was already ingested with the same `rawText`.
- **Re-capture** happens automatically if fixture text in the catalog changed or the thought was deleted.

Use `--fresh-corpus` (CLI) or **Reset corpus & start** (UI) when you need a clean slate — e.g. after changing fixture text or debugging edit tests that left shared fixtures modified.

### Automatic retrieval-only prune (broken ingest on graded fixtures)

When a **check** entry finds ingest failures (embedding, extraction, entities, graph, ontology) on a fixture that is also listed in **`retrievalRelevant`**, the harness **automatically**:

1. Updates **`eval_qa`** — removes those fixture ids from `retrievalRelevant` only (captures and structural checks unchanged; clears `needleFixtureId` if the needle was pruned).
2. On the **retrieval** step in the same run — grades NDCG without those fixtures and skips the needle-in-top-K check for an ingest-broken needle.

Pure retrieval failures (healthy ingest, bad rank) are **not** auto-pruned. The **needle** (`checks.retrieval.needleFixtureId`) is never auto-pruned or excluded from grading — a needle ingest failure shows up on the **check** step and retrieval still runs (NDCG / needle-in-top-K may fail until ingest is fixed).

If a prior run cleared `retrievalQuery` on a needle-only QA, run `npm run db:migrate` (see `drizzle/0036_eval_qa_restore_jonas_retrieval.sql`) or re-enter retrieval fields in the Q&A editor.

## Model

- **`eval_qa`** — catalog row: captures, question, acceptance, optional retrieval query/grades, optional edit step, tags, **`checks_json`** (structural assertions)
- **`eval_run` / `eval_entry` / `eval_event` / `eval_thought_map`** — run state and results
- **`evals/datasets/corpus.yaml`** — optional `fixtureId` → `rawText` fallback when expanding captures

## Layout

```
evals/
  run.ts                 # CLI (smoke | all)
  datasets/corpus.yaml   # optional fixture text
  harness/
    qa-run.ts            # expand eval_qa → entries (capture → check → …)
    qa-checks.ts         # deterministic graph/entity/ontology/embedding checks
    run-entry.ts         # execute capture / check / retrieval / edit / answer
    capture-fidelity.ts
    judge-acceptance.ts
    retrieval-sweep.ts
    prune-retrieval-relevant.ts  # drop broken-ingest fixtures from retrieval grades only
    synthesis.ts
```

## Per-question flow

Each QA run expands to: **captures** → **check** (deterministic) → optional **retrieval** → optional **edit** → **answer** (LLM judge) → synthesis.

`checks_json` keys: `graph`, `relations`, `entities`, `ontology`, `extraction`, `embedding`, `retrieval`, `learning`. Empty `{}` uses defaults (graph nodes, embedding, active ontology category, enrichment).

## Concern coverage (seeded QAs)

| Concern                       | Seeded QA(s)                                                                |
| ----------------------------- | --------------------------------------------------------------------------- |
| Graph working                 | all (graph.requireThoughtNodes)                                             |
| Thoughts linked               | qa_contradiction_remote_work (relations)                                    |
| Entity counts / surfaces      | qa_smoke_dinner, qa_haystack_walnut, …                                      |
| Ontology in classification    | all (ontology.requireActiveCategories)                                      |
| Ontology extends over time    | qa_ontology_growth (profile cursor + guidance)                              |
| Extraction / enrichment       | all (extraction.requireEnriched)                                            |
| Ontology qualitative fit      | answer acceptance text per QA                                               |
| Embedding + lexical           | all (embedding.requireVector)                                               |
| Recall / NDCG                 | qa_haystack_walnut, retrieval QAs                                           |
| Needle in haystack            | qa_haystack_walnut (needleFixtureId + top-K)                                |
| Summarize                     | qa_synthesis_priya_books                                                    |
| Learn from user               | qa_edit_allergy_update                                                      |
| Improve over time             | qa_ontology_growth, retrieval learning flags                                |
| Dense operative detail recall | `qa_surgical_*` (tag `surgical_memory`) — numeric/landmark/device specifics |

## North-star eval: the company brain (`evals/brain/`, CB0)

How far the company brain is from `plan/phase-company-brain.md` §9, re-measured at every CB milestone.

- **Fixture** (`fixture/company.ts`): Fjordlight Studio — 4 members (owner, admin, 2 members), a Sales group, #general and private #sales, two DMs, a shared `sales@` mailbox with one Acme mail, the Acme pricing call with transcript (+ a guest), Drive (handbook, brand guide, `Pitch deck v3.pptx`, a shared-with-some proposal, two private docs), calendar (incl. one private event), contacts (one unshared), Memory thoughts for two members (one sensitive). Every item carries a unique **marker** in its text: seeing it in a tool result or answer is provenance, not a reading of meaning.
- **Seeding** (`fixture/seed.ts`) goes through the module services; direct writes only where no service can run here (users, the mail domain, received mail via the inbox store, the call + transcript via the calls stores) — listed in the file.
- **Database**: its own, `ee_eval_brain` on the local test Postgres, dropped, recreated and bootstrapped like a box on every run (≈3 s). Refuses any non-local `DATABASE_URL`.
- **Suites** (`suites/`): Knows 22 (cited answers), Does 13 (graded on the rows left behind), Keeps 14 leak + 6 judgment. Each item is tagged with its concept layer (act / happen / understand / initiate).
- **Grading**: structure where structure answers (state rows, markers); a closed-set JSON judge through the gateway otherwise (`judge.ts`, moves to Jev in CB2).

```bash
npm run db:up
npm run eval:brain                                    # static: no model — every member's read tools crawled (tool-level Keeps, Knows reachability)
npm run eval:brain -- --mode chat --provider mock       # the real /api/chat path against the e2e mock gateway (runner check; judge parts not graded)
npm run eval:brain -- --mode chat --provider platform   # real model, once per release: needs PLATFORM_LLM_BASE_URL/_API_KEY/_MODEL_CHAT/_MODEL_EMBEDDING
npm run eval:brain -- --mode chat --provider platform --only K01,L03
```

Reports: `evals/reports/brain/<date>-<sha>-<mode>.json` + `.md` (gitignored). The unit gate runs the static half (`static.pg.spec.ts`, needs `DATABASE_URL` like every `*.pg.spec.ts`) against the ratchet in `baseline.ts`: a new leak fails, and so does a fixed one until it is struck from the list.

## Graph-scale cost benchmark

Operator-owned economics harness (not QA pass/fail). Measures gateway USD and latency vs corpus size using **atomic single-thought captures** (`evals/graph-scale/datasets/single-thought-corpus.yaml`) — not `evals/datasets/corpus.yaml` or LongMemEval.

```bash
npm run graph-scale              # smoke: 1 thought, capture track only
npm run graph-scale:bench        # 50 + 100 thoughts, capture + Q&A
npm run graph-scale -- --sizes 50,100,250 --tracks qa
npm run graph-scale -- --sizes 1000 --confirm-spend
```

See [`docs/planning/graph-scale-cost.md`](../docs/planning/graph-scale-cost.md) and `evals/graph-scale/`.

### Live UI watch (Playwright)

While a graph-scale run is ingesting, you can sign in as the fresh corpus harness tenant and watch thoughts + graph growth in the browser:

```bash
# (no dev server: the Playwright watcher starts its own preview)
# terminal 1 — start the benchmark
npm run graph-scale

# terminal 2 — attach the watcher (headed browser, 60m timeout)
npm run test:e2e:graph-scale-watch
```

The watcher polls `GET /api/e2e/graph-scale/live` (dev only), logs enrich + entity counts, reloads `/capture` and `/memory`, and fails early if enrich stalls for 10 minutes or entities stay at zero after 8 enrichments.
