#!/usr/bin/env bash
# Runs one gate step and records how long it took, so `npm run gate:times` can show
# where a push / release spends its time.
#   scripts/gate-step.sh <gate> <step> -- <command …>
# Appends "<run>\t<commit>\t<gate>\t<step>\t<seconds>\t<exit>\t<finished at>" to
# <git common dir>/ee-gate/timings.tsv and exits with the command's status.
# EE_GATE_RUN groups the steps of one push (scripts/push.sh, ci-local.sh and tag-gate.sh set it).
set -uo pipefail

[ $# -ge 4 ] && [ "$3" = "--" ] || { echo "usage: gate-step.sh <gate> <step> -- <command …>" >&2; exit 2; }
gate="$1"
step="$2"
shift 3

dir="$(git rev-parse --git-common-dir)/ee-gate"
mkdir -p "$dir"
run="${EE_GATE_RUN:?EE_GATE_RUN is not set (the gate scripts set it)}"
head="$(git rev-parse --short=12 HEAD)"

echo "⏱  $gate › $step …"
start=$SECONDS
"$@"
status=$?
took=$((SECONDS - start))

printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$run" "$head" "$gate" "$step" "$took" "$status" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$dir/timings.tsv"
if [ "$status" -eq 0 ]; then
  echo "⏱  $gate › $step: ${took}s"
else
  echo "⏱  $gate › $step: failed (exit $status) after ${took}s" >&2
fi
exit "$status"
