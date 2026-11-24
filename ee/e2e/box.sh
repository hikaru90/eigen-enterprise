#!/bin/sh
# ee/e2e/box.sh up|install|shell|down|module-check — a local systemd box for ee install tests.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT="$HERE/../.."
NAME=ee-box
case "${1:-}" in
  up)
    docker build -q --platform "linux/${EE_BOX_ARCH:-arm64}" -t ee-box -f "$HERE/Dockerfile.box" "$HERE" >/dev/null
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    # --restart: the box doubles as THE local install (one managed system per
    # machine, decision 2026-10-22), so it comes back with Docker after reboots.
    docker run -d --name "$NAME" --platform "linux/${EE_BOX_ARCH:-arm64}" --privileged --cgroupns=host \
      --restart unless-stopped \
      -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
      -v "$ROOT/dist/release:/release:ro" -p 443:443 -p 80:80 \
      -p 7881:7881/tcp -p 7882:7882/udp ee-box >/dev/null
    sleep 3; docker exec "$NAME" systemctl is-system-running --wait || true ;;
  install)
    # Calls media: the browser runs on this machine and reaches the published ports on
    # loopback, so LiveKit advertises 127.0.0.1 (a real server passes its public IP).
    # The box is a container, so the install demands the HOST's UDP buffer limits
    # (D8). These sysctls are global and only writable from the host's network
    # namespace, so a throwaway privileged container on the Docker VM's host
    # network raises them (only ever up, never lowered). Docker Desktop resets its
    # VM on restart, hence on every install.
    docker run --rm --privileged --net=host --platform "linux/${EE_BOX_ARCH:-arm64}" --entrypoint sh ee-box -c \
      'set -e; for k in rmem_max wmem_max; do f=/proc/sys/net/core/$k; [ "$(cat $f)" -ge 5000000 ] || echo 5000000 > $f; echo "→ host net.core.$k = $(cat $f)"; done'
    docker exec "$NAME" sh /release/install.sh --from /release --console-host "${2:-os.ee.test}" --node-ip 127.0.0.1 --contribute-hub off ;;
  module-check)
    # The module workload checks (plan/phase-upgrades-u2.md §9 Stream B) on systemd, in a
    # THROWAWAY box of its own (never the install box above, never a real server): ee's
    # module code (e2e/module-check.ts, bundled) deploys the hello fixture and a probe
    # module with a hub key made for the run, and checks the units from the inside.
    # Its own cgroup namespace, no published ports, removed afterwards (KEEP=1 keeps it).
    CHECK=ee-box-modules
    ARCH="${EE_BOX_ARCH:-arm64}"
    NODE_VERSION=$(sed -n 's/^NODE_VERSION="\(.*\)"$/\1/p' "$HERE/../install.sh")
    OUT=$(mktemp -d)
    trap 'rm -rf "$OUT"; [ "${KEEP:-0}" = 1 ] || docker rm -f "$CHECK" >/dev/null 2>&1 || true' EXIT
    (cd "$HERE/.." && npx esbuild e2e/module-check.ts --bundle --platform=node --target=node22 --format=esm \
      --alias:zod=zod --alias:js-yaml=js-yaml --log-level=warning --outfile="$OUT/module-check.mjs" \
      --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);")
    docker build -q --platform "linux/$ARCH" -t ee-box-modules -f "$HERE/Dockerfile.box" "$HERE" >/dev/null
    docker rm -f "$CHECK" >/dev/null 2>&1 || true
    docker run -d --name "$CHECK" --platform "linux/$ARCH" --privileged --cgroupns=private \
      --tmpfs /run --tmpfs /run/lock ee-box-modules >/dev/null
    docker exec "$CHECK" systemctl is-system-running --wait >/dev/null 2>&1 || true
    docker exec -e NODE_VERSION="$NODE_VERSION" -e NODE_ARCH="$ARCH" "$CHECK" sh -euc '
      R=/opt/ee/runtimes/node-22; T="node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"; W=$(mktemp -d)
      curl -fsSL --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/$T" -o "$W/$T"
      curl -fsSL --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$W/SHASUMS256.txt"
      (cd "$W" && grep " $T\$" SHASUMS256.txt | sha256sum -c --quiet -)
      mkdir -p "$R" && tar -xJf "$W/$T" -C "$R" --strip-components=1 --no-same-owner
      useradd --system --no-create-home --shell /usr/sbin/nologin ee-build
      mkdir -p /var/lib/ee/workloads /var/lib/ee/company /etc/ee /var/lib/ee-state/os /check
      chmod 711 /var/lib/ee /var/lib/ee/workloads; chmod 700 /etc/ee /var/lib/ee/company
      echo not-a-real-key > /etc/ee/master.key; chmod 400 /etc/ee/master.key
      echo sealed > /var/lib/ee/secrets.enc; chmod 600 /var/lib/ee/secrets.enc'
    docker cp "$OUT/module-check.mjs" "$CHECK:/check/module-check.mjs"
    docker cp "$ROOT/contracts/fixtures/modules/hello" "$CHECK:/check/hello"
    docker exec "$CHECK" /opt/ee/runtimes/node-22/bin/node /check/module-check.mjs /check/hello ;;
  shell) docker exec -it "$NAME" bash ;;
  down) docker rm -f "$NAME" ;;
  *) echo "usage: box.sh up|install [host]|shell|down|module-check" >&2; exit 2 ;;
esac
