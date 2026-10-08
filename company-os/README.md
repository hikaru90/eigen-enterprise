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
| `COMPANY_OS_SITES_DIR` | Absolute path where generated websites are committed as git repositories (the founder's ownership artifact) — required at render time, fail-loud |
| `COMPANY_OS_TEST_DATABASE_URL` | Postgres URL for the PG test suite (tests skip loudly without it) |

## Commands

```sh
npm run co -- doctor   # is everything in place? prints the exact fix for what isn't
npm run co -- chat     # the founder conversation in your terminal
npm run co -- smoke    # the wedge journey end-to-end against a production build (scripted LLM, no browser)
npm run co -- e2e      # the same journey in a real browser (Playwright; E2E_HEADLESS=1 for CI)
npm test               # vitest (in-memory suites always; PG suites when COMPANY_OS_TEST_DATABASE_URL is set)
npm run typecheck      # tsc --noEmit
```

## Verify before you say ready

**"Ready" means proven, not plausible.** No company-os change ships without:

- `npm run co -- smoke` green — the real product (production build, real Postgres on a
  disposable `company_os_e2e` database, real git, real HTTP) walked through
  setup → the 7-question interview → render → reveal → the committed site served at
  `/site`. Only the LLM is a scripted wire-compatible gateway (`e2e/mock-llm.ts`).
- `npm run co -- e2e` green whenever the UI flow was touched — the same journey in
  Chromium, plus the honest-failure journeys (wrong key → exact provider error;
  audit rejection → nothing published; reload → nothing lost).

Unit tests prove the machinery. These commands prove the product.

## Layout

```
src/llm.ts       streaming OpenAI-compatible client (DI transport for tests)
src/tools.ts     JSON-schema tool registry
src/loop.ts      reasoning loop: reason → tool → observe (streamed events)
src/session.ts   conversation persistence (Postgres + in-memory test double)
src/memory.ts    company memory, append-only, latest-wins (v0)
src/resume.ts    resume context ("You were setting up <company> — where were we?")
src/db.ts        fail-loud connection
src/migrate.ts   dead-simple ordered SQL runner (migrations/)
modules/website/ the first module (M3): module.json, copy drafting + W5 audit,
                 typographic template, render_website tool, theme tokens
src/lib/server/site-store.ts  the generated site as a git repo — commit per render (W4)
src/lib/server/preview.ts     the reveal: /site serves exactly what was committed
```

## Local PG tests

Requires a disposable database (the dev cluster's `eigen-db` has one: `company_os_test`).
Note: the cluster preloads Apache AGE, whose hook breaks `DROP TABLE` in databases
without `ag_catalog` — tests reset via TRUNCATE/DELETE, never DROP.
