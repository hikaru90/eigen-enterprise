#!/usr/bin/env bash
# Browser e2e (npm run test:e2e): test DB up + migrated, browsers installed, then Playwright.
# Each phase is a timed step (scripts/gate-step.sh); Playwright also writes its JSON report next
# to the timings, so `npm run gate:times` lists the slowest e2e files. Extra arguments go to
# `playwright test` (npm run test:e2e -- src/routes/e2e/foo.e2e.ts).
set -euo pipefail
cd "$(dirname "$0")/.."

export EE_GATE_RUN="${EE_GATE_RUN:-$(date +%Y%m%dT%H%M%S)-$$}"
gate="${EE_GATE:-e2e}"
reports="$(git rev-parse --git-common-dir)/ee-gate"
mkdir -p "$reports"

step() { scripts/gate-step.sh "$gate" "$@"; }

step db:up -- npm run -s db:up
step db:wait -- npm run -s db:wait
step db:migrate -- npm run -s db:migrate
step playwright-install -- npx playwright install
PLAYWRIGHT_JSON_OUTPUT_NAME="$reports/playwright.json" \
  step playwright-test -- npx playwright test --reporter=list,json "$@"
