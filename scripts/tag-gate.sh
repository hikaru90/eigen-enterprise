#!/usr/bin/env bash
# The release gate (plan/phase-upgrades.md §8 U1): a v* tag may only be pushed
# for a commit on which BOTH ran green here:
#   - the upgrade rehearsal (scripts/upgrade-rehearsal.mjs): the previous stable
#     release's schema + the demo seed, this tree's migrations, then the previous
#     release's read smoke against the new schema;
#   - the browser e2e suite (npm run test:e2e).
# Green records the commit in <git common dir>/ee-gate/tag-passed. The pre-push
# hook refuses a v* tag whose commit is not that one (it runs this script when
# the tag is on HEAD); `npm run push -- origin main vX.Y.Z` runs it before git
# connects, like the CI gate. Plain branch pushes never run it.
set -euo pipefail

# Inside a hook git exports GIT_DIR / GIT_INDEX_FILE; the specs and the
# rehearsal's own git calls must not inherit them.
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX || true

stamp_dir="$(git rev-parse --git-common-dir)/ee-gate"
head="$(git rev-parse HEAD)"

# A release is exactly what is tagged: the gate refuses to vouch for a dirty tree.
dirty="$(git status --porcelain --untracked-files=no)"
if [ -n "$dirty" ]; then
  echo "tag-gate: uncommitted changes to tracked files; a release gate runs on the committed tree only:" >&2
  printf '%s\n' "$dirty" >&2
  exit 1
fi

# Each phase is timed (scripts/gate-step.sh); `npm run gate:times` shows the breakdown.
export EE_GATE_RUN="${EE_GATE_RUN:-$(date +%Y%m%dT%H%M%S)-$$}"
trap 'node "$(git rev-parse --show-toplevel)/scripts/gate-times.mjs" --run "$EE_GATE_RUN" --brief || true' EXIT
# Both phases are cached by their inputs (scripts/gate-cache.mjs; EE_GATE_NO_CACHE=1 runs them).
# The rehearsal also reads the previous stable release, picked from the v* tags merged into HEAD
# and the ones on HEAD: every such tag and its commit is part of its key.
gate_step="$(git rev-parse --show-toplevel)/scripts/gate-step.sh"
release_tags="$( { git tag --merged HEAD --list 'v*'; echo '@HEAD'; git tag --points-at HEAD --list 'v*'; } | while read -r t; do
  if [ "$t" = "@HEAD" ]; then echo "$t"; else echo "$t $(git rev-parse "$t^{commit}")"; fi
done)"
echo "tag-gate: upgrade rehearsal on $head …"
"$gate_step" release upgrade-rehearsal --cache --cache-extra "$release_tags" -- node scripts/upgrade-rehearsal.mjs
echo "tag-gate: e2e on $head …"
# e2e.sh times its own phases; --outer only adds a row when the whole suite is a cache hit.
EE_GATE=release "$gate_step" release e2e --cache --outer -- npm run test:e2e

if [ "$(git rev-parse HEAD)" != "$head" ]; then
  echo "tag-gate: HEAD moved while the gate ran ($head → $(git rev-parse HEAD)); not stamping. Run it again." >&2
  exit 1
fi

mkdir -p "$stamp_dir"
printf '%s\n' "$head" > "$stamp_dir/tag-passed"
echo "tag-gate: rehearsal + e2e green for $head (stamped)"
