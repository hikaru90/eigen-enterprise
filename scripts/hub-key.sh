#!/bin/sh
# Generate the module hub's receipt signing key (Ed25519) — once, by the owner
# (plan/phase-upgrades-u2.md §5 "Hub trust", §6.3). Modelled on scripts/release-key.sh.
#
#   scripts/hub-key.sh            the current key (the hub signs every module receipt with it)
#   scripts/hub-key.sh --backup   the offline backup key (only if the current one is lost or leaked)
#
# Current key: writes the private key to ~/.config/eigenenterprise/module-hub-signing.pem
# (0600, never overwritten), embeds the public key (base64 DER SPKI) in ee/src/hub-key.ts
# between the "BEGIN/END MODULE HUB PUBLIC KEY" markers, and prints how to hand the
# private key to the hub box as its MODULE_HUB_SIGNING_KEY ee secret (base64 DER PKCS#8).
#
# Backup key (--backup): writes ~/.config/eigenenterprise/module-hub-backup-signing.pem
# (0600, never overwritten) and embeds its public key between the "BEGIN/END MODULE HUB
# BACKUP PUBLIC KEY" markers only. It must NOT go to the hub box: move it offline and
# delete the local copy. Refuses when a backup key is already embedded.
# Needs OpenSSL 3 or newer (raw Ed25519); macOS's LibreSSL is not enough (brew install openssl@3).
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DIR="$HOME/.config/eigenenterprise"
TS="$ROOT/ee/src/hub-key.ts"

[ $# -le 1 ] || { echo "✗ usage: scripts/hub-key.sh [--backup]" >&2; exit 1; }
case "${1:-}" in
  '') BACKUP=0; KEY="$DIR/module-hub-signing.pem"; MARK='MODULE HUB PUBLIC KEY'; CONST=MODULE_HUB_PUBLIC_KEY_SPKI; WHAT='module hub key' ;;
  --backup) BACKUP=1; KEY="$DIR/module-hub-backup-signing.pem"; MARK='MODULE HUB BACKUP PUBLIC KEY'; CONST=MODULE_HUB_BACKUP_PUBLIC_KEY_SPKI; WHAT='backup module hub key' ;;
  *) echo "✗ unknown argument: $1 (usage: scripts/hub-key.sh [--backup])" >&2; exit 1 ;;
esac

[ ! -e "$KEY" ] || { echo "✗ $KEY already exists — refusing to overwrite the $WHAT" >&2; exit 1; }
grep -q "^// BEGIN $MARK " "$TS" || { echo "✗ no BEGIN $MARK marker in $TS" >&2; exit 1; }
if [ "$BACKUP" = 1 ]; then
  # The local copy is deleted once it is offline, so the file check alone cannot stop a second backup replacing the first.
  # Between the markers: hub-key.ts holds `= HUB_BACKUP_KEY_PLACEHOLDER` until a backup key is embedded.
  awk -v m="$MARK" '$0 ~ "^// BEGIN " m " " { on = 1; next } $0 ~ "^// END " m "$" { on = 0 } on' "$TS" | grep -q 'PLACEHOLDER' \
    || { echo "✗ $TS already embeds a backup module hub key — refusing to replace it" >&2; exit 1; }
fi
openssl version | grep -Eq '^OpenSSL ([3-9]|[1-9][0-9]+)\.' || { echo "✗ needs OpenSSL 3 or newer (found: $(openssl version))" >&2; exit 1; }

mkdir -p "$DIR" && chmod 700 "$DIR"
(umask 077 && openssl genpkey -algorithm ed25519 -out "$KEY")
chmod 600 "$KEY"
SPKI=$(openssl pkey -in "$KEY" -pubout -outform DER | base64 | tr -d '\n')

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# Replace the lines strictly between the $MARK markers with the file $1 holds.
splice() { # splice <replacement-file> <target>
  awk -v repl="$1" -v m="$MARK" '
    $0 ~ "^// BEGIN " m " " { print; while ((getline line < repl) > 0) print line; skip = 1; next }
    $0 ~ "^// END " m "$" { skip = 0 }
    !skip { print }
  ' "$2" > "$TMP/out" && cat "$TMP/out" > "$2"
}
printf "export const %s: string = '%s'\n" "$CONST" "$SPKI" > "$TMP/ts"
splice "$TMP/ts" "$TS"

if [ "$BACKUP" = 0 ]; then
  echo "✓ private key: $KEY (keep it safe; it signs every module receipt)"
  echo "✓ public key embedded in ee/src/hub-key.ts — commit it"
  echo
  echo "Now give the hub box the private key as its MODULE_HUB_SIGNING_KEY (base64 DER PKCS#8),"
  echo "on the hub box as root, with the value on stdin (never on the command line):"
  echo
  echo "  openssl pkey -in $KEY -outform DER | base64 | tr -d '\\n'   # here: the value"
  echo "  ee secret set os MODULE_HUB_SIGNING_KEY                     # there: paste it on stdin"
else
  echo "✓ backup private key: $KEY"
  echo "✓ backup public key embedded in ee/src/hub-key.ts — commit it"
  echo
  echo "!! This backup key must NOT go to the hub box or any secret store."
  echo "!! Move it offline now (password manager / USB stick), then delete the local copy:"
  echo
  echo "     rm $KEY"
  echo
  echo "!! It is only used if the current module hub key is lost or leaked."
fi
