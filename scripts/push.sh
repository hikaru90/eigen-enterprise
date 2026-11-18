#!/usr/bin/env bash
# git push with the local CI gate run BEFORE git connects to the remote.
# Usage: npm run push -- origin main v1.2.3   (any `git push` arguments)
set -euo pipefail

stamp_file="$(git rev-parse --git-common-dir)/ee-gate/passed"
head="$(git rev-parse HEAD)"

if [ "$(cat "$stamp_file" 2>/dev/null || true)" = "$head" ]; then
  echo "push: gate already green for $head"
else
  "$(dirname "$0")/ci-gate.sh"
fi

# The pre-push hook finds the stamp and lets the push through at once.
exec git push "$@"
