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

# Each step is cached by its inputs (scripts/gate-cache.mjs): a step whose inputs already ran green
# is skipped. EE_GATE_NO_CACHE=1 runs them all.
step() { local name="$1"; shift; scripts/gate-step.sh ci "$name" --cache "$@"; }

step lint -- npm run -s lint
step lint:migrations -- npm run -s lint:migrations
step assert:svelte-naming -- npm run -s assert:svelte-naming
step check -- npm run -s check
step contract:check -- npm run -s contract:check
# Test cache (scripts/test-cache/README.md): only the spec files a change can affect since the
# suite last passed on a clean tree; EE_GATE_FULL=1 runs all of them.
step test:unit -- node scripts/test-cache/vitest.mjs unit -- --reporter=default --reporter=json --outputFile.json="$reports/vitest-unit.json"
step test:components -- node scripts/test-cache/vitest.mjs components -- --reporter=default --reporter=json --outputFile.json="$reports/vitest-components.json"
