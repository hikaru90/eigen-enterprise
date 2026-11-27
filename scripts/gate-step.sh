#!/usr/bin/env bash
# Runs one gate step and records how long it took, so `npm run gate:times` can show
# where a push / release spends its time.
#   scripts/gate-step.sh <gate> <step> [--cache] [--cache-extra <text>] [--outer] -- <command …>
# Appends "<run>\t<commit>\t<gate>\t<step>\t<seconds>\t<exit>\t<finished at>\t<cached>" to
# <git common dir>/ee-gate/timings.tsv and exits with the command's status.
# EE_GATE_RUN groups the steps of one push (scripts/push.sh, ci-local.sh and tag-gate.sh set it).
#
# --cache: skip the step when its input hash (scripts/gate-cache.mjs) already ran green, and
#   record the hash when it goes green now (only if the inputs did not change while it ran).
#   EE_GATE_NO_CACHE=1 runs every step anyway. --cache-extra adds inputs from outside the tree.
# --outer: the command times its own steps (e2e.sh); only a cache hit gets a row here.
set -uo pipefail

usage() { echo "usage: gate-step.sh <gate> <step> [--cache] [--cache-extra <text>] [--outer] -- <command …>" >&2; exit 2; }
[ $# -ge 3 ] || usage
gate="$1"
step="$2"
shift 2
cache=false
extra=""
outer=false
while [ $# -gt 0 ] && [ "$1" != "--" ]; do
  case "$1" in
    --cache) cache=true ;;
    --cache-extra) [ $# -ge 2 ] || usage; extra="$2"; shift ;;
    --outer) outer=true ;;
    *) usage ;;
  esac
  shift
done
[ $# -ge 2 ] && [ "$1" = "--" ] || usage
shift

dir="$(git rev-parse --git-common-dir)/ee-gate"
mkdir -p "$dir"
run="${EE_GATE_RUN:?EE_GATE_RUN is not set (the gate scripts set it)}"
head="$(git rev-parse --short=12 HEAD)"
cache_js="$(dirname "$0")/gate-cache.mjs"
row() { printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$run" "$head" "$gate" "$step" "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$3" >> "$dir/timings.tsv"; }

key=""
if [ "$cache" = true ]; then
  if [ "${EE_GATE_NO_CACHE:-}" = "1" ]; then
    echo "⏱  $gate › $step: cache off (EE_GATE_NO_CACHE=1)"
  else
    key="$(node "$cache_js" key --gate "$gate" --step "$step" --extra "$extra" -- "$@")" || { echo "gate-step: could not hash the inputs of $gate › $step" >&2; exit 1; }
    if hit="$(node "$cache_js" lookup "$key")"; then
      echo "⏱  $gate › $step: $hit"
      row 0 0 "cached:${key:0:12}"
      exit 0
    fi
  fi
fi

echo "⏱  $gate › $step …"
start=$SECONDS
"$@"
status=$?
took=$((SECONDS - start))

[ "$outer" = true ] || row "$took" "$status" ""
if [ "$status" -eq 0 ]; then
  echo "⏱  $gate › $step: ${took}s"
  if [ -n "$key" ]; then
    after="$(node "$cache_js" key --gate "$gate" --step "$step" --extra "$extra" -- "$@")" || { echo "gate-step: could not hash the inputs of $gate › $step" >&2; exit 1; }
    if [ "$after" = "$key" ]; then
      node "$cache_js" record "$key" --gate "$gate" --step "$step" || exit 1
    else
      echo "⏱  $gate › $step: inputs changed while it ran; not cached" >&2
    fi
  fi
else
  echo "⏱  $gate › $step: failed (exit $status) after ${took}s" >&2
fi
exit "$status"
