# company-os E2E — "ready" means proven in a real browser

**Status:** SHIPPED 2026-09-22 (same day). Smoke + 4 browser journeys green; caught and fixed 3 real product bugs on its first runs (see progress.md).
**Trigger (owner, verbatim):** "what happened a lot of times now is that you are telling
me that it's ready and that I then open the dev server and look at the page and nothing
works." — "I want you to be able to test the work you did and evaluate the work you did."

## Thesis

Unit tests prove the machinery. They do NOT prove the product. From now on, company-os
work is "ready" only when a one-command harness has run the REAL product — production
build (adapter-node), real Postgres, real git, real HTTP, real browser — through the
founder journey and reported honestly. No more ready-without-proof.

## What gets built

1. **`scripts/co.ts` — one CLI to interact with and verify the tool** (`npm run co <cmd>`):
   - `doctor` — checks every dependency the product needs (env vars, DB reachability,
     migrations, git, sites dir writable, browser install) and prints the exact fix for
     whatever is missing. The answer machine for "why does nothing work".
   - `chat` — the existing founder conversation CLI, wired through the dispatcher;
     after a render it prints the site location and the `/site` path.
   - `smoke` — headless end-to-end, no browser: harness up → drive the API exactly like
     the UI does (session → provider setup → SSE turns → `/site`) → assert reveal,
     committed repo, served HTML. Deterministic, seconds-fast, runnable anytime.
   - `e2e` — the same stack, plus Playwright browser journeys (headed by default,
     `E2E_HEADLESS=1` to override).
2. **Mock LLM gateway** (`e2e/mock-llm.ts`) — OpenAI-compatible streaming server with
   scripted turn sequences: provider verify, arrival, the 7 answers, render draft+audit,
   reveal; plus failure scripts (provider 401, audit rejection). A model call that
   deviates from the script fails LOUD with the actual request — product drift and test
   drift are both visible.
3. **E2E stack harness** (`e2e/harness.ts`) — disposable database `company_os_e2e`
   derived from `COMPANY_OS_DATABASE_URL`'s server (dropped + created per run; that name
   only), fresh migrations, temp sites dir, `vite build` + node server on an ephemeral
   port, readiness wait, teardown. Shared by smoke and e2e.
4. **Browser journeys** (`e2e/journey.spec.ts`):
   - **J1 — the wedge journey:** open `/` → guided provider setup (mock gateway creds)
     → arrival question in the real chatbox → founder types all answers → render
     progress lines appear → reveal → `/site` shows the drafted headline/monogram/lang
     → sites dir holds the v0.1 commit with `content.json` provenance.
   - **J2 — honest failures:** wrong key surfaces the provider's exact 401; audit
     rejection leaves NO commit and the error is explained; `/site` before any render is
     an honest 404.
   - **J3 — resume:** reload mid-conversation → "You were setting up … — where were
     we?" → continue without loss.
5. **Definition of done (binding):** company-os changes ship only with
   `npm run co smoke` green — and `npm run co e2e` green whenever the UI flow was
   touched — results quoted in `plan/progress.md`.

## Env contract

Product envs stay fail-loud, no defaults. Test-only defaults (mock port 5177, server
port 5178, e2e db name) live in the harness — they are test fixtures, not product
fallbacks.

## Order of execution

1. harness + mock gateway → 2. smoke journey (HTTP) → 3. `co doctor` + dispatcher →
4. Playwright journeys → 5. run everything, fix every REAL bug it exposes (expected —
that is the point) → 6. README + progress.md + commit.

## Non-goals for this pass

Real-LLM browser runs (owner-key consent + output-quality judging = M8 eval, separate);
the main repo's e2e suite (unaffected); CI wiring (the harness is one command — CI comes
free later).
