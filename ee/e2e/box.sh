#!/bin/sh
# ee/e2e/box.sh up|install|shell|down — a local systemd box for ee install tests.
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
      -v "$ROOT/dist/release:/release:ro" -p 443:443 -p 80:80 ee-box >/dev/null
    sleep 3; docker exec "$NAME" systemctl is-system-running --wait || true ;;
  install)
    docker exec "$NAME" sh /release/install.sh --from /release --console-host "${2:-os.ee.test}" ;;
  shell) docker exec -it "$NAME" bash ;;
  down) docker rm -f "$NAME" ;;
  *) echo "usage: box.sh up|install [host]|shell|down" >&2; exit 2 ;;
esac
