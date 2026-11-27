#!/usr/bin/env bash
# Browser e2e (npm run test:e2e): test DB up + migrated, browsers installed, then Playwright.
# Each phase is a timed step (scripts/gate-step.sh); Playwright also writes its JSON report next
# to the timings, so `npm run gate:times` lists the slowest e2e files. Extra arguments go to
# `playwright test` (npm run test:e2e -- src/routes/e2e/foo.e2e.ts).
#
# Parallel: E2E_WORKERS (default 4) Playwright workers, each on its own harness stack
# (playwright.config.ts shards). Each gets its own database, cloned from a freshly
# prepared template under a prefix unique to this run (ee_e2e_<run>); the trap drops
# exactly those on exit. The shared test database is never migrated or reset here.
set -euo pipefail
cd "$(dirname "$0")/.."

export EE_GATE_RUN="${EE_GATE_RUN:-$(date +%Y%m%dT%H%M%S)-$$}"
gate="${EE_GATE:-e2e}"
reports="$(git rev-parse --git-common-dir)/ee-gate"
mkdir -p "$reports"

step() { scripts/gate-step.sh "$gate" "$@"; }

step db:up -- npm run -s db:up
step db:wait -- npm run -s db:wait
export E2E_WORKERS="${E2E_WORKERS:-4}"
export E2E_DB_PREFIX="ee_e2e_$(printf '%s' "$EE_GATE_RUN" | tr -c 'a-zA-Z0-9' '_' | tr 'A-Z' 'a-z')"
drop_dbs() { node scripts/e2e-databases.mjs drop "$E2E_DB_PREFIX" "$E2E_WORKERS" || echo "[e2e] could not drop the ${E2E_DB_PREFIX}_* databases" >&2; }
trap drop_dbs EXIT
step db:migrate -- node scripts/e2e-databases.mjs create "$E2E_DB_PREFIX" "$E2E_WORKERS"
step playwright-install -- npx playwright install
PLAYWRIGHT_JSON_OUTPUT_NAME="$reports/playwright.json" \
  step playwright-test -- npx playwright test --reporter=list,json "$@"
