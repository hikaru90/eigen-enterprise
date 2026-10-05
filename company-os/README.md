# company-os

The wedge thin slice: *describe your company → a company OS on your own server in 10 minutes.*

Governed by `../plan/phase-wedge.md` (decisions W1–W8). Self-contained package — zero imports from the parent repo's app code.

## Env

| Variable | Purpose |
|---|---|
| `COMPANY_OS_LLM_BASE_URL` | OpenAI-compatible endpoint (e.g. `https://api.openai.com/v1`) — required, fail-loud |
| `COMPANY_OS_LLM_API_KEY` | API key — required, fail-loud |
| `COMPANY_OS_LLM_MODEL` | Model id — required, fail-loud |
| `COMPANY_OS_DATABASE_URL` | Postgres URL — required for anything DB-backed, fail-loud |
| `COMPANY_OS_TEST_DATABASE_URL` | Postgres URL for the PG test suite (tests skip loudly without it) |

## Commands

```sh
npm install
npm test          # vitest (in-memory suites always; PG suites when COMPANY_OS_TEST_DATABASE_URL is set)
npm run typecheck # tsc --noEmit
```

## Layout

```
src/llm.ts       streaming OpenAI-compatible client (DI transport for tests)
src/tools.ts     JSON-schema tool registry
src/loop.ts      reasoning loop: reason → tool → observe (streamed events)
src/session.ts   conversation persistence (Postgres + in-memory test double)
src/memory.ts    company memory, append-only, latest-wins (Eigen Mesh v0)
src/resume.ts    resume context ("You were setting up <company> — where were we?")
src/db.ts        fail-loud connection
src/migrate.ts   dead-simple ordered SQL runner (migrations/)
```

## Local PG tests

Requires a disposable database (the dev cluster's `eigen-db` has one: `company_os_test`).
Note: the cluster preloads Apache AGE, whose hook breaks `DROP TABLE` in databases
without `ag_catalog` — tests reset via TRUNCATE/DELETE, never DROP.
