#!/bin/sh
# eigenEnterprise installer (plan/phase-substrate.md §5).
#
#   curl -fsSL <base>/install.sh | sh -s -- --from <base> --node-ip <public IP> [--console-host os.example.com] [--acme-email you@example.com]
#   [--contribute-hub https://<central board> | off]   (default: the official board, kept on upgrades)
#   sh install.sh --from /root/release --node-ip <public IP>   (files copied to the box beforehand)
#
# <base> holds: SHA256SUMS + SHA256SUMS.sig (Ed25519-signed by the release key, checked
# before anything is installed), LATEST (the release name), ee.mjs, and per CPU
# eigenenterprise-<version>-<sha>-linux-<x64|arm64>.tar.gz (+ .sha256) and
# livekit-server-<LIVEKIT_VERSION>-linux-<x64|arm64>.tar.gz (+ .sha256).
# Published: <base> = https://github.com/hikaru90/eigen-enterprise/releases/latest/download
# Re-running it on an installed server upgrades in place and keeps everything (`ee upgrade` does that).
# Installs a pinned, checksum-verified Node runtime and ee, then hands over to `ee bootstrap`.
#
# Calls (livekit-server): --node-ip is the IP browsers send call media to. It is
# required on the first install (and on the first upgrade to a release with calls),
# then kept. The server's firewall must let in the media ports — 7881/tcp and
# 7882/udp, or the pair given with --rtc-ports <tcp>,<udp> — and DNS for
# rtc.<console host> must point here (the calls host follows the console host).
#
# Hosted boxes (a VM behind a shared-IP router; self-hosted installs pass none of these):
#   --rtc-ports <tcp>,<udp>      the media port pair the router forwards to this VM (20000–29999), kept on re-runs
#   --trusted-proxy <IPv4 CIDR>  the router; Caddy then takes PROXY protocol v2 from it on :443/:80, kept on re-runs
#   --claim-hash <sha256>        first install only: the claim link was minted by whoever set up the server
set -eu

NODE_VERSION="22.23.3"
# Must match scripts/release.sh (ee/src/livekit-release.spec.ts checks it).
LIVEKIT_VERSION="1.13.11"
FROM=""
PASS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --console-host|--acme-email|--node-ip|--contribute-hub|--rtc-ports|--trusted-proxy|--claim-hash) PASS="$PASS $1 $2"; shift 2 ;;
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

# BEGIN SIGNED RELEASE (plan/phase-managed-box.md M5; ee/src/install-verify.spec.ts runs this block)
# Only a release whose SHA256SUMS is signed by the project's Ed25519 key installs.
release_public_key() {
# BEGIN RELEASE PUBLIC KEY (written by scripts/release-key.sh)
  cat <<'PEM'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAKvl3XdC1tUoV6fLiwOpijRl2xs92UJmt4rRqvzJPRvA=
-----END PUBLIC KEY-----
PEM
# END RELEASE PUBLIC KEY
}

verify_release() { # verify_release <dir>: <dir>/SHA256SUMS is signed (<dir>/SHA256SUMS.sig, base64) by the release key
  release_public_key > "$1/release-key.pem"
  grep -q -- '-----BEGIN PUBLIC KEY-----' "$1/release-key.pem" || { echo "✗ this build has no release signing key (run scripts/release-key.sh)" >&2; exit 1; }
  tr -d '\r\n' < "$1/SHA256SUMS.sig" | openssl base64 -d -A > "$1/SHA256SUMS.sig.bin" 2>/dev/null \
    && openssl pkeyutl -verify -pubin -inkey "$1/release-key.pem" -rawin -in "$1/SHA256SUMS" -sigfile "$1/SHA256SUMS.sig.bin" >/dev/null 2>&1 \
    || { echo "✗ the release SHA256SUMS is not signed by the eigenEnterprise release key — refusing to install" >&2; exit 1; }
  SIGNED_SUMS="$1/SHA256SUMS"
}

signed() { # signed <file> <name>: <file> is the <name> the verified SHA256SUMS lists
  [ -n "${SIGNED_SUMS:-}" ] || { echo "✗ internal: signed() before verify_release" >&2; exit 1; }
  expected=$(awk -v n="$2" '$2 == n || $2 == "*" n { print $1 }' "$SIGNED_SUMS")
  [ -n "$expected" ] || { echo "✗ the signed SHA256SUMS does not list $2" >&2; exit 1; }
  actual=$(sha256sum "$1" | cut -d' ' -f1)
  [ "$expected" = "$actual" ] || { echo "✗ checksum mismatch for $2 (not the signed release)" >&2; exit 1; }
}
# END SIGNED RELEASE

command -v curl >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates xz-utils >/dev/null; }
command -v xz >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xz-utils >/dev/null

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

step "verifying the release signature"
command -v openssl >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssl >/dev/null
fetch SHA256SUMS "$WORK/SHA256SUMS"
fetch SHA256SUMS.sig "$WORK/SHA256SUMS.sig"
verify_release "$WORK"

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
signed "$WORK/ee.mjs" ee.mjs
install -D -m 0755 "$WORK/ee.mjs" /opt/ee/ee.mjs
cat > /usr/local/bin/ee <<SH
#!/bin/sh
exec $RUNTIME/bin/node /opt/ee/ee.mjs "\$@"
SH
chmod 0755 /usr/local/bin/ee

step "fetching the eigenEnterprise release"
case "$FROM" in
  http://*|https://*)
    # LATEST names the release (eigenenterprise-<version>-<sha>); each CPU has its own tarball.
    fetch LATEST "$WORK/LATEST"
    signed "$WORK/LATEST" LATEST
    NAME=$(tr -d '[:space:]' < "$WORK/LATEST")
    case "$NAME" in
      eigenenterprise-[0-9]*) RELEASE="$NAME-linux-$ARCH.tar.gz" ;;
      *) echo "✗ $FROM/LATEST does not name a release" >&2; exit 1 ;;
    esac ;;
  *) RELEASE=$(cd "$FROM" && ls eigenenterprise-*-linux-$ARCH.tar.gz | sort | tail -n 1) ;;
esac
[ -n "$RELEASE" ] || { echo "✗ no eigenenterprise release for linux-$ARCH in $FROM" >&2; exit 1; }
fetch "$RELEASE" "$WORK/$RELEASE"
signed "$WORK/$RELEASE" "$RELEASE"

step "fetching livekit-server $LIVEKIT_VERSION (calls)"
LIVEKIT="livekit-server-$LIVEKIT_VERSION-linux-$ARCH.tar.gz"
fetch "$LIVEKIT" "$WORK/$LIVEKIT"
signed "$WORK/$LIVEKIT" "$LIVEKIT"

# shellcheck disable=SC2086
/usr/local/bin/ee bootstrap --release "$WORK/$RELEASE" --livekit-release "$WORK/$LIVEKIT" $PASS
