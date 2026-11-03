#!/bin/sh
# ee/e2e/restore-drill.sh — the backups proof (plan/phase-backups.md §3):
#   a company with Messages + Drive data → backup to MinIO → destroy the box →
#   fresh install → `ee restore` with the recovery code → messages, files and
#   revisions are back.
#
# Runs against the local systemd test box (ee/e2e/box.sh). It DESTROYS and
# re-creates that box. Do not run it on a box anyone else is using.
#
# Prerequisites
#   - a release in dist/release (scripts/release.sh arm64)
#   - the box installed and CLAIMED, with some Messages and Drive data
#     (send a few messages, upload a file, edit it once so it has revisions)
#   - Docker on this machine (a MinIO container is started and removed here)
#
# Usage
#   ee/e2e/restore-drill.sh [console-host]        (default os.ee.localhost)
#
# Steps (each prints → and stops on the first failure):
#   1. start MinIO (k1-drill-minio) reachable from the box, create the bucket
#   2. the owner sets backups up in Settings → Backups and passes the ONE
#      company recovery code (EE1-…) as RECOVERY_CODE (first run prints how)
#   3. record what the company holds now (row counts, Drive blob hashes)
#   4. `ee backup`, then `ee restore --verify` (decrypt + hash check, read-only)
#   5. destroy the box, bring up a fresh one, install the same release
#   6. `ee restore --snapshot latest` with the bucket flags, secret key and
#      recovery code on stdin
#   7. wait for os to be live again and compare with step 3
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOST="${1:-os.ee.localhost}"
BOX=ee-box
MINIO=k1-drill-minio
MINIO_IMAGE='cgr.dev/chainguard/minio@sha256:3c60a2a8c4d33409a9bc7a623a7fcbfb4605adc3d89422d2f53b3f673a6e5597'
MINIO_PORT=9312
AK=drilladmin
SK=${MINIO_SECRET:-drill-secret-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')}
BUCKET=ee-drill
# The box reaches the host's MinIO through Docker's host gateway.
ENDPOINT="http://host.docker.internal:${MINIO_PORT}"
WORK=$(mktemp -d)
step() { printf '\n→ %s\n' "$*"; }
box() { docker exec "$BOX" "$@"; }
ctl() { # method path [json] — ee's control API inside the box
  box curl -sS --fail-with-body --unix-socket /run/ee/control/ee.sock -X "$1" -H 'content-type: application/json' ${3:+--data "$3"} "http://ee$2"
}
psql_os() { box runuser -u postgres -- psql -tAq -d os -c "$1"; }
snapshot_state() { # → file with counts + blob hashes
  {
    for t in messages message_conversations drive_file drive_revision drive_folder; do
      printf '%s %s\n' "$t" "$(psql_os "select count(*) from $t")"
    done
    box sh -c 'find /var/lib/ee-state/os/drive/blobs -type f -printf "%f\n" 2>/dev/null | sort' | sed 's/^/blob /'
    box sh -c 'test -f /var/lib/ee-state/os/agent/agent.sqlite && echo "agent.sqlite present" || echo "agent.sqlite absent"'
  } > "$1"
}

step "1. MinIO ($MINIO on :$MINIO_PORT)"
if [ -z "${MINIO_KEEP:-}" ]; then
docker rm -f "$MINIO" >/dev/null 2>&1 || true
docker run -d --name "$MINIO" -p "$MINIO_PORT:9000" -e MINIO_ROOT_USER=$AK -e MINIO_ROOT_PASSWORD="$SK" "$MINIO_IMAGE" server /data >/dev/null
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$MINIO_PORT/minio/health/live" >/dev/null && break; sleep 1; done
box sh -c "grep -q host.docker.internal /etc/hosts || echo \"\$(ip route | awk '/default/{print \$3}') host.docker.internal\" >> /etc/hosts"
# Creating the bucket is the bucket owner's job, not ee's (curl signs SigV4 itself).
curl -sS --fail-with-body --aws-sigv4 "aws:amz:us-east-1:s3" --user "$AK:$SK" -X PUT "http://127.0.0.1:$MINIO_PORT/$BUCKET"
fi

step "2. backups set up by the owner (Settings → Backups), with the company recovery code"
# Setup is an owner action in the app (D11): it derives the backup key from the
# company root key and hands only that key to ee. ONE code (EE1-…) for everything.
[ -n "${RECOVERY_CODE:-}" ] || {
  cat <<MSG
✗ set backups up first, then re-run with the code:
    MinIO is running. In https://$HOST → Settings → Backups enter
      endpoint $ENDPOINT, region us-east-1, bucket $BUCKET, folder drill,
      path-style, access key $AK, secret key $SK
    Test connection → Save → copy the company recovery code (EE1-…), then:
    MINIO_KEEP=1 RECOVERY_CODE='EE1-…' MINIO_SECRET='$SK' $0 $HOST
MSG
  exit 1
}
CODE=$RECOVERY_CODE
ctl GET /v1/backups | grep -q '"configured":true' || { echo "✗ ee says backups are not set up"; exit 1; }
box systemctl list-timers ee-backup.timer --no-pager

step "3. what the company holds now"
snapshot_state "$WORK/before.txt"; cat "$WORK/before.txt" | grep -v '^blob ' ; echo "blobs: $(grep -c '^blob ' "$WORK/before.txt" || true)"

step "4. ee backup + ee restore --verify"
box /opt/ee/runtimes/node-22/bin/node /opt/ee/ee.mjs backup
# --verify on the box itself uses the sealed bucket config; only the recovery code is asked.
printf '%s\n' "$CODE" | docker exec -i "$BOX" /opt/ee/runtimes/node-22/bin/node /opt/ee/ee.mjs restore --verify --snapshot latest

step "5. destroy the box; fresh install of the same release"
"$HERE/box.sh" down
"$HERE/box.sh" up
"$HERE/box.sh" install "$HOST"
box sh -c "grep -q host.docker.internal /etc/hosts || echo \"\$(ip route | awk '/default/{print \$3}') host.docker.internal\" >> /etc/hosts"

step "6. ee restore --snapshot latest"
printf '%s\n%s\n' "$SK" "$CODE" | docker exec -i "$BOX" /opt/ee/runtimes/node-22/bin/node /opt/ee/ee.mjs restore --snapshot latest \
  --endpoint "$ENDPOINT" --region us-east-1 --bucket "$BUCKET" --prefix drill --addressing path --access-key-id "$AK"

step "7. wait for os, compare"
for i in $(seq 1 120); do
  box /opt/ee/runtimes/node-22/bin/node /opt/ee/ee.mjs status 2>/dev/null | grep -q '"release"' && break; sleep 5
done
snapshot_state "$WORK/after.txt"
if diff -u "$WORK/before.txt" "$WORK/after.txt"; then
  echo "\n✓ restored: messages, Drive files, revisions and blobs match ($WORK)"
  echo "  now open https://$HOST, sign in as the owner, open Messages and Drive and check a file's revisions by eye."
else
  echo "\n✗ the restored company differs (see diff above; $WORK)"; exit 1
fi
step "cleanup"
docker rm -f "$MINIO" >/dev/null
