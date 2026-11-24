#!/usr/bin/env bash
# git push with the local CI gate run BEFORE git connects to the remote.
# Usage: npm run push -- origin main v1.2.3   (any `git push` arguments)
# Naming a v* tag also runs the release gate (scripts/tag-gate.sh: upgrade
# rehearsal + e2e) first, unless it is already green for HEAD. The pre-push
# hook enforces both either way (--tags / --follow-tags included).
set -euo pipefail

gate_dir="$(git rev-parse --git-common-dir)/ee-gate"
head="$(git rev-parse HEAD)"

if [ "$(cat "$gate_dir/passed" 2>/dev/null || true)" = "$head" ]; then
  echo "push: gate already green for $head"
else
  "$(dirname "$0")/ci-gate.sh"
fi

names_release_tag=false
for arg in "$@"; do
  ref="${arg#+}"
  ref="${ref%%:*}"
  case "$ref" in
    refs/tags/v*) names_release_tag=true ;;
    v*) git rev-parse -q --verify "refs/tags/$ref" >/dev/null && names_release_tag=true ;;
  esac
done

if [ "$names_release_tag" = true ]; then
  if [ "$(cat "$gate_dir/tag-passed" 2>/dev/null || true)" = "$head" ]; then
    echo "push: release gate already green for $head"
  else
    "$(dirname "$0")/tag-gate.sh"
  fi
fi

# The pre-push hook finds the stamps and lets the push through at once.
exec git push "$@"
