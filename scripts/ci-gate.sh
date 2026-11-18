#!/usr/bin/env bash
# Runs the local CI gate (npm run ci:local) and, when it is green, records the
# commit it ran on in <git common dir>/ee-gate/passed. The pre-push hook accepts
# any push whose commits are that commit or its ancestors without running the
# gate again.
#
# Why: git opens the connection to the remote BEFORE the pre-push hook runs. The
# gate takes minutes, the idle connection is dropped, and the push dies with
# exit 141 (SIGPIPE) although every check passed. Running the gate first
# (`npm run push`) or retrying after a green hook run avoids that.
set -euo pipefail

# Inside a hook git exports GIT_DIR / GIT_INDEX_FILE; in a worktree they leak
# into the specs that create temporary repos. The gate never needs them.
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX || true

stamp_dir="$(git rev-parse --git-common-dir)/ee-gate"
head="$(git rev-parse HEAD)"

dirty="$(git status --porcelain --untracked-files=no)"

npm run ci:local

if [ "$(git rev-parse HEAD)" != "$head" ]; then
  echo "ci-gate: HEAD moved while the gate ran ($head → $(git rev-parse HEAD)); not stamping. Run it again." >&2
  exit 1
fi

mkdir -p "$stamp_dir"
printf '%s\n' "$head" > "$stamp_dir/passed"
echo "ci-gate: green for $head (stamped)"
if [ -n "$dirty" ]; then
  # Same as the old hook: the gate checks the working tree as it is.
  echo "ci-gate: note — it also checked uncommitted changes to tracked files:" >&2
  printf '%s\n' "$dirty" >&2
fi
