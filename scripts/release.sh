#!/usr/bin/env bash
# Build an eigenEnterprise release for ee (plan/phase-substrate.md D7):
#   dist/release/eigenenterprise-<version>-linux-<arch>.tar.gz   (+ .sha256)
#   dist/release/ee.mjs                                          (the ee binary bundle)
#   dist/release/install.sh
#   dist/release/LATEST                                          (the release name, for install.sh --from <url>)
#   dist/release/NOTES.md                                        (what changed since the previous v* tag; Settings → Updates shows it)
#   dist/release/SHA256SUMS                                      (all of the above; the workflow re-makes and signs it)
#   dist/release/livekit-server-<LIVEKIT_VERSION>-linux-<arch>.tar.gz (+ .sha256)   (calls, plan/video-calls.md §4)
# Published by .github/workflows/release.yml (amd64 + arm64) on a v* tag.
# The tarball is built inside a Linux container so production node_modules match the
# target (native modules). Docker is a BUILD tool here only; nothing runs in containers on the box.
set -eu
ARCH="${1:-amd64}"
case "$ARCH" in amd64) NODE_ARCH=x64 ;; arm64) NODE_ARCH=arm64 ;; *) echo "arch must be amd64 or arm64" >&2; exit 2 ;; esac

# livekit-server (Apache-2.0), pinned: the version and the sha256 LiveKit publishes for
# each linux tarball (https://github.com/livekit/livekit/releases/tag/v1.13.11, checksums.txt).
# ee/install.sh fetches the same version; ee/src/livekit-release.spec.ts keeps them in step.
LIVEKIT_VERSION=1.13.11
LIVEKIT_SHA256_amd64=1e9ee90ca301e1842b2887fc77cb122759756a9c8aeb4334ee91de3325ec43fb
LIVEKIT_SHA256_arm64=2af6ce091d6b3c79d1677f8ff1bbb91a8007f40b2325c059b52d38383c0830b6
case "$ARCH" in amd64) LIVEKIT_SHA256=$LIVEKIT_SHA256_amd64 ;; arm64) LIVEKIT_SHA256=$LIVEKIT_SHA256_arm64 ;; esac
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
  # Production packages only: what build/server and the preStart scripts (postgres) import at runtime.
  # Build and test tools (paraglide's 250 MB native binary, vite, eslint, three for the client …) stay out.
  cd /stage && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
  # Nothing reads these at runtime: the server starts without --enable-source-maps, and no .d.ts or
  # README is ever loaded. (PostHog's source-map upload runs on the build tree, not on the release.)
  find build node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -iname '*.md' \) -delete
  tar -czf /out/$NAME.tar.gz -C /stage .
"
rm -f "$OUT/src.tar"
# Keep only this release for the arch, so installers pick it unambiguously.
find "$OUT" -name "eigenenterprise-*-linux-${NODE_ARCH}.tar.gz*" ! -name "$NAME.tar.gz*" -delete
(cd "$OUT" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256" && shasum -a 256 ee.mjs > ee.mjs.sha256)
LIVEKIT_NAME="livekit-server-${LIVEKIT_VERSION}-linux-${NODE_ARCH}"
echo "→ packing livekit-server $LIVEKIT_VERSION for linux/$ARCH (checksum-pinned)"
cp "$ROOT/ee/livekit/ee.json" "$OUT/livekit-ee.json"
# The binary is never run here: it is fetched, checked against the pin, and packed with its ee.json.
# Reproducible archive (sorted, mtime 0, root-owned, gzip -n): the same pin gives the same bytes,
# so the same sha256 — ee does not restart livekit (dropping calls) on an upgrade that keeps the version.
docker run --rm -v "$OUT:/out" -w /work node:22-bookworm sh -euc "
  curl -fsSL --retry 3 -o upstream.tar.gz https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_linux_${ARCH}.tar.gz
  echo '${LIVEKIT_SHA256}  upstream.tar.gz' | sha256sum -c --quiet -
  mkdir upstream stage
  tar -xzf upstream.tar.gz -C upstream --no-same-owner
  [ -f upstream/livekit-server ] || { echo 'livekit-server is not in the upstream tarball' >&2; exit 1; }
  [ -f upstream/LICENSE ] || { echo 'LICENSE is not in the upstream tarball' >&2; exit 1; }
  install -m 0755 upstream/livekit-server stage/livekit-server
  install -m 0644 upstream/LICENSE stage/LICENSE
  install -m 0644 /out/livekit-ee.json stage/ee.json
  chmod 0755 stage
  tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - -C stage . | gzip -n > /out/${LIVEKIT_NAME}.tar.gz
"
rm -f "$OUT/livekit-ee.json"
find "$OUT" -name "livekit-server-*-linux-${NODE_ARCH}.tar.gz*" ! -name "$LIVEKIT_NAME.tar.gz*" -delete
(cd "$OUT" && shasum -a 256 "$LIVEKIT_NAME.tar.gz" > "$LIVEKIT_NAME.tar.gz.sha256")

printf '%s\n' "eigenenterprise-${VERSION}-${SHA}" > "$OUT/LATEST"
# Release notes: the commits since the previous release tag (signed with the rest, so Settings → Updates
# shows exactly what was signed). CI checks out the full history for this.
PREV=$(git -C "$ROOT" describe --tags --abbrev=0 --match 'v[0-9]*' --exclude "v$VERSION" HEAD) || { echo "✗ no earlier v* tag to write release notes from" >&2; exit 1; }
{
  printf '# eigenEnterprise %s\n\nChanges since %s:\n\n' "$VERSION" "$PREV"
  git -C "$ROOT" log --no-merges --format='- %s' "$PREV..HEAD" | head -n 80
} > "$OUT/NOTES.md"
# One manifest over everything this build produced (signed in the release workflow, M5).
(cd "$OUT" && shasum -a 256 LATEST NOTES.md install.sh ee.mjs "$NAME.tar.gz" "$LIVEKIT_NAME.tar.gz" > SHA256SUMS)
rm -f "$OUT/SHA256SUMS.sig"
# On the owner's machine the release key signs it too, so the local box (ee/e2e/box.sh) installs it.
# CI builds have no key here: the publish job signs the combined manifest.
SIGNING_KEY="$HOME/.config/eigenenterprise/release-signing.pem"
if [ -f "$SIGNING_KEY" ]; then
  openssl pkeyutl -sign -rawin -inkey "$SIGNING_KEY" -in "$OUT/SHA256SUMS" | openssl base64 -A > "$OUT/SHA256SUMS.sig"
  echo "✓ signed SHA256SUMS with $SIGNING_KEY"
else
  echo "! SHA256SUMS is unsigned (no $SIGNING_KEY): install.sh refuses this build until it is signed (scripts/release-key.sh)"
fi
echo "✓ $OUT/$NAME.tar.gz"
echo "✓ $OUT/$LIVEKIT_NAME.tar.gz"
