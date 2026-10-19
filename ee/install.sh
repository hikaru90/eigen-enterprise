#!/bin/sh
# eigenEnterprise installer (plan/phase-substrate.md §5).
#
#   curl -fsSL <base>/install.sh | sh -s -- --from <base> [--console-host os.example.com] [--acme-email you@example.com]
#   sh install.sh --from /root/release        (files copied to the box beforehand)
#
# <base> holds: ee.mjs, ee.mjs.sha256, eigenenterprise-*.tar.gz, eigenenterprise-*.tar.gz.sha256.
# Installs a pinned, checksum-verified Node runtime and ee, then hands over to `ee bootstrap`.
set -eu

NODE_VERSION="22.23.3"
FROM=""
PASS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --console-host|--acme-email) PASS="$PASS $1 $2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$FROM" ] || { echo "✗ --from <url-or-dir> is required" >&2; exit 2; }
[ "$(id -u)" = "0" ] || { echo "✗ run as root" >&2; exit 1; }

case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "✗ unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac

step() { printf '→ %s\n' "$1"; }

fetch() { # fetch <name> <dest>
  case "$FROM" in
    http://*|https://*) curl -fsSL --retry 3 "$FROM/$1" -o "$2" ;;
    *) cp "$FROM/$1" "$2" ;;
  esac
}

verify() { # verify <file> <sha256-file-with-"hash  name">
  expected=$(cut -d' ' -f1 < "$2")
  actual=$(sha256sum "$1" | cut -d' ' -f1)
  [ "$expected" = "$actual" ] || { echo "✗ checksum mismatch for $1" >&2; exit 1; }
}

command -v curl >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates xz-utils >/dev/null; }
command -v xz >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xz-utils >/dev/null

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

RUNTIME="/opt/ee/runtimes/node-22"
if [ ! -x "$RUNTIME/bin/node" ] || [ "$("$RUNTIME/bin/node" -v)" != "v$NODE_VERSION" ]; then
  step "installing Node $NODE_VERSION (pinned, checksum-verified)"
  TARBALL="node-v$NODE_VERSION-linux-$ARCH.tar.xz"
  curl -fsSL --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/$TARBALL" -o "$WORK/$TARBALL"
  curl -fsSL --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
  (cd "$WORK" && grep " $TARBALL\$" SHASUMS256.txt | sha256sum -c --quiet -)
  rm -rf "$RUNTIME.partial" && mkdir -p "$RUNTIME.partial"
  tar -xJf "$WORK/$TARBALL" -C "$RUNTIME.partial" --strip-components=1 --no-same-owner
  rm -rf "$RUNTIME" && mv "$RUNTIME.partial" "$RUNTIME"
fi

step "installing ee"
fetch ee.mjs "$WORK/ee.mjs"
fetch ee.mjs.sha256 "$WORK/ee.mjs.sha256"
verify "$WORK/ee.mjs" "$WORK/ee.mjs.sha256"
install -D -m 0755 "$WORK/ee.mjs" /opt/ee/ee.mjs
cat > /usr/local/bin/ee <<SH
#!/bin/sh
exec $RUNTIME/bin/node /opt/ee/ee.mjs "\$@"
SH
chmod 0755 /usr/local/bin/ee

step "fetching the eigenEnterprise release"
case "$FROM" in
  http://*|https://*) RELEASE=$(curl -fsSL "$FROM/LATEST") ;;
  *) RELEASE=$(cd "$FROM" && ls eigenenterprise-*-linux-$ARCH.tar.gz | sort | tail -n 1) ;;
esac
[ -n "$RELEASE" ] || { echo "✗ no eigenenterprise release for linux-$ARCH in $FROM" >&2; exit 1; }
fetch "$RELEASE" "$WORK/$RELEASE"
fetch "$RELEASE.sha256" "$WORK/$RELEASE.sha256"
verify "$WORK/$RELEASE" "$WORK/$RELEASE.sha256"

# shellcheck disable=SC2086
/usr/local/bin/ee bootstrap --release "$WORK/$RELEASE" $PASS
