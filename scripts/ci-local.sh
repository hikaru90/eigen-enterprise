#!/usr/bin/env bash
# The local CI gate (npm run ci:local): each check runs as a timed step (scripts/gate-step.sh),
# stopping at the first failure. `npm run gate:times` shows where the time went, including the
# slowest unit and component spec files (vitest's JSON reports, written next to the timings).
set -euo pipefail
cd "$(dirname "$0")/.."

export EE_GATE_RUN="${EE_GATE_RUN:-$(date +%Y%m%dT%H%M%S)-$$}"
reports="$(git rev-parse --git-common-dir)/ee-gate"
mkdir -p "$reports"
trap 'node scripts/gate-times.mjs --run "$EE_GATE_RUN" --brief || true' EXIT

step() { scripts/gate-step.sh ci "$@"; }

step lint -- npm run -s lint
step lint:migrations -- npm run -s lint:migrations
step assert:svelte-naming -- npm run -s assert:svelte-naming
step check -- npm run -s check
step contract:check -- npm run -s contract:check
step test:unit -- npm run -s test:unit -- --reporter=default --reporter=json --outputFile.json="$reports/vitest-unit.json"
step test:components -- npm run -s test:components -- --reporter=default --reporter=json --outputFile.json="$reports/vitest-components.json"
