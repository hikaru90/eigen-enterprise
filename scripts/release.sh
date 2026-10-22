#!/bin/sh
# Build an eigenEnterprise release for ee (plan/phase-substrate.md D7):
#   dist/release/eigenenterprise-<version>-linux-<arch>.tar.gz   (+ .sha256)
#   dist/release/ee.mjs                                          (the ee binary bundle)
#   dist/release/install.sh
# The tarball is built inside a Linux container so production node_modules match the
# target (native modules). Docker is a BUILD tool here only; nothing runs in containers on the box.
set -eu
ARCH="${1:-amd64}"
case "$ARCH" in amd64) NODE_ARCH=x64 ;; arm64) NODE_ARCH=arm64 ;; *) echo "arch must be amd64 or arm64" >&2; exit 2 ;; esac
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(node -p "require('$ROOT/package.json').version")
SHA=$(git -C "$ROOT" rev-parse --short=12 HEAD)
OUT="$ROOT/dist/release"
NAME="eigenenterprise-${VERSION}-${SHA}-linux-${NODE_ARCH}"
mkdir -p "$OUT"

echo "→ bundling ee"
(cd "$ROOT/ee" && npm ci --silent && npm run -s bundle)
cp "$ROOT/ee/dist/ee.mjs" "$OUT/ee.mjs"
cp "$ROOT/ee/install.sh" "$OUT/install.sh"

echo "→ building $NAME in a linux/$ARCH container"
# -co: tracked + untracked-but-not-ignored. Files deleted in the worktree but
# not yet committed still come back from ls-files — keep only what exists.
(cd "$ROOT" && git ls-files -co --exclude-standard -z | while IFS= read -r -d '' f; do [ -f "$f" ] && printf '%s\0' "$f"; done | COPYFILE_DISABLE=1 tar --no-xattrs --null -cf "$OUT/src.tar" -T -)
docker run --rm --platform "linux/$ARCH" -v "$OUT:/out" -w /work node:22-bookworm sh -euc "
  tar -xf /out/src.tar -C /work
  npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
  node scripts/npm-prepare.mjs
  PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com PUBLIC_POSTHOG_KEY= BETTER_AUTH_SECRET=build-only AGE_GRAPH_NAME=eigen_graph LLM_API_KEY=build-only DATABASE_URL=postgres://build@localhost/build ORIGIN=http://localhost npm run build
  mkdir -p /stage
  cp -r build drizzle scripts package.json package-lock.json ee.json /stage/
  mkdir -p /stage/src/lib/server/db && cp src/lib/server/db/enable_rls.sql /stage/src/lib/server/db/
  # Same as the Dockerfile runner: scripts/ (migrations, role setup) import dev deps like postgres.
  cd /stage && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
  tar -czf /out/$NAME.tar.gz -C /stage .
"
rm -f "$OUT/src.tar"
# Keep only this release for the arch, so installers pick it unambiguously.
find "$OUT" -name "eigenenterprise-*-linux-${NODE_ARCH}.tar.gz*" ! -name "$NAME.tar.gz*" -delete
(cd "$OUT" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256" && shasum -a 256 ee.mjs > ee.mjs.sha256)
echo "✓ $OUT/$NAME.tar.gz"
