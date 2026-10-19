#!/bin/sh
# Run eigenEnterprise on this Mac exactly as it runs on a VPS: an Ubuntu 24.04
# "server" (systemd as PID 1) in Docker, installed with the real installer
# (ee/install.sh → ee bootstrap). Docker only emulates the server; inside it,
# everything runs natively under systemd, like production.
#
#   scripts/local-server.sh up        build the release (if needed), boot the server, install → prints the URL
#   scripts/local-server.sh status    ee status (domains, workloads, recent events)
#   scripts/local-server.sh logs [w]  logs of a workload (default: os = eigenEnterprise)
#   scripts/local-server.sh shell     root shell on the server
#   scripts/local-server.sh stop|start
#   scripts/local-server.sh reset     destroy the server and its data, install fresh
#   scripts/local-server.sh ca        where the server's local certificate authority is (to trust it)
#
# The console is https://os.ee.localhost (browsers resolve *.localhost to this Mac).
# Ports 80/443 on this Mac go to the server's Caddy.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NAME=ee-box
HOST="${EE_CONSOLE_HOST:-os.ee.localhost}"
case "$(uname -m)" in arm64|aarch64) ARCH=arm64; NODE_ARCH=arm64 ;; *) ARCH=amd64; NODE_ARCH=x64 ;; esac

need_release() {
  ls "$ROOT"/dist/release/eigenenterprise-*-linux-"$NODE_ARCH".tar.gz >/dev/null 2>&1 || return 0
  # Rebuild when the code moved past the release's commit.
  release=$(ls "$ROOT"/dist/release/eigenenterprise-*-linux-"$NODE_ARCH".tar.gz | tail -n 1)
  case "$release" in *"$(git -C "$ROOT" rev-parse --short=12 HEAD)"*) return 1 ;; *) return 0 ;; esac
}

boot() {
  docker build -q --platform "linux/$ARCH" -t ee-box -f "$ROOT/ee/e2e/Dockerfile.box" "$ROOT/ee/e2e" >/dev/null
  docker run -d --name "$NAME" --hostname ee-server --platform "linux/$ARCH" --privileged --cgroupns=host \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
    -v "$ROOT/dist/release:/release:ro" -p 443:443 -p 80:80 ee-box >/dev/null
  until docker exec "$NAME" systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded'; do sleep 1; done
}

install() {
  docker exec "$NAME" sh /release/install.sh --from /release --console-host "$HOST"
  echo
  echo "Open https://$HOST (first visit: accept the local certificate, or run \`$0 ca\` to trust it)."
  echo "The first account you create owns the company."
}

case "${1:-}" in
  up)
    if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
      docker start "$NAME" >/dev/null
      echo "Server already exists and is started: https://$HOST  (use \`$0 reset\` for a fresh install)"
      exit 0
    fi
    if need_release; then echo "→ building the release (a few minutes)"; "$ROOT/scripts/release.sh" "$ARCH"; fi
    echo "→ booting the Ubuntu 24.04 server"
    boot
    install ;;
  reset)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    if need_release; then echo "→ building the release (a few minutes)"; "$ROOT/scripts/release.sh" "$ARCH"; fi
    boot
    install ;;
  status) docker exec "$NAME" ee status ;;
  logs) docker exec "$NAME" ee logs "${2:-os}" ;;
  shell) docker exec -it "$NAME" bash ;;
  stop) docker stop "$NAME" >/dev/null && echo stopped ;;
  start) docker start "$NAME" >/dev/null && echo "started: https://$HOST" ;;
  ca)
    docker cp "$NAME:/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt" "$ROOT/dist/ee-local-ca.crt"
    echo "Saved the server's root certificate to dist/ee-local-ca.crt."
    echo "To trust it on this Mac, open it in Keychain Access and set it to Always Trust (macOS will ask for your password)." ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
