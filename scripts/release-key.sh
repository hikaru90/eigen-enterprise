#!/bin/sh
# Generate an eigenEnterprise release signing key (Ed25519) — once, by the owner
# (plan/phase-managed-box.md M5, plan/phase-upgrades.md §6.2).
#
#   scripts/release-key.sh            the current key (CI signs every release with it)
#   scripts/release-key.sh --backup   the offline backup key (only if the current one is lost or leaked)
#
# Current key: writes the private key to ~/.config/eigenenterprise/release-signing.pem
# (0600, never overwritten), embeds the public key in ee/src/release-key.ts and
# ee/install.sh (between the "BEGIN/END RELEASE PUBLIC KEY" markers), and prints the
# command that hands the private key to the release workflow.
#
# Backup key (--backup): writes ~/.config/eigenenterprise/release-backup-signing.pem
# (0600, never overwritten) and embeds its public key between the "BEGIN/END RELEASE
# BACKUP PUBLIC KEY" markers only. It must NOT go to CI or GitHub secrets: move it
# offline and delete the local copy. Refuses when a backup key is already embedded.
# Needs OpenSSL 3 or newer (raw Ed25519); macOS's LibreSSL is not enough (brew install openssl@3).
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DIR="$HOME/.config/eigenenterprise"
TS="$ROOT/ee/src/release-key.ts"
SH="$ROOT/ee/install.sh"

[ $# -le 1 ] || { echo "✗ usage: scripts/release-key.sh [--backup]" >&2; exit 1; }
case "${1:-}" in
  '') BACKUP=0; KEY="$DIR/release-signing.pem"; MARK='RELEASE PUBLIC KEY'; CONST=RELEASE_PUBLIC_KEY_PEM; WHAT='release key' ;;
  --backup) BACKUP=1; KEY="$DIR/release-backup-signing.pem"; MARK='RELEASE BACKUP PUBLIC KEY'; CONST='RELEASE_BACKUP_PUBLIC_KEY_PEM: string'; WHAT='backup release key' ;;
  *) echo "✗ unknown argument: $1 (usage: scripts/release-key.sh [--backup])" >&2; exit 1 ;;
esac

[ ! -e "$KEY" ] || { echo "✗ $KEY already exists — refusing to overwrite the $WHAT" >&2; exit 1; }
for f in "$TS" "$SH"; do
  grep -q "^// BEGIN $MARK\|^# BEGIN $MARK" "$f" || { echo "✗ no BEGIN $MARK marker in $f" >&2; exit 1; }
done
if [ "$BACKUP" = 1 ]; then
  # The local copy is deleted once it is offline, so the file check alone cannot stop a second backup replacing the first.
  # Between the markers: release-key.ts holds `= BACKUP_PLACEHOLDER`, install.sh echoes the placeholder line.
  for f in "$TS" "$SH"; do
    awk -v m="$MARK" '$0 ~ "^(//|#) BEGIN " m { on = 1; next } $0 ~ "^(//|#) END " m { on = 0 } on' "$f" | grep -q 'PLACEHOLDER' \
      || { echo "✗ $f already embeds a backup release key — refusing to replace it" >&2; exit 1; }
  done
fi
openssl version | grep -Eq '^OpenSSL ([3-9]|[1-9][0-9]+)\.' || { echo "✗ needs OpenSSL 3 or newer (found: $(openssl version))" >&2; exit 1; }

mkdir -p "$DIR" && chmod 700 "$DIR"
(umask 077 && openssl genpkey -algorithm ed25519 -out "$KEY")
chmod 600 "$KEY"
PUB=$(openssl pkey -in "$KEY" -pubout)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# Replace the lines strictly between the $MARK markers with the file $1 holds.
splice() { # splice <replacement-file> <target>
  awk -v repl="$1" -v m="$MARK" '
    $0 ~ "^(//|#) BEGIN " m { print; while ((getline line < repl) > 0) print line; skip = 1; next }
    $0 ~ "^(//|#) END " m { skip = 0 }
    !skip { print }
  ' "$2" > "$TMP/out" && cat "$TMP/out" > "$2"
}
{ printf 'export const %s = `%s\n`\n' "$CONST" "$PUB"; } > "$TMP/ts"
{ printf "  cat <<'PEM'\n%s\nPEM\n" "$PUB"; } > "$TMP/sh"
splice "$TMP/ts" "$TS"
splice "$TMP/sh" "$SH"

if [ "$BACKUP" = 0 ]; then
  echo "✓ private key: $KEY (keep it safe; it signs every release)"
  echo "✓ public key embedded in ee/src/release-key.ts and ee/install.sh — commit them"
  echo
  echo "Now give the release workflow the private key:"
  echo
  echo "  gh secret set EE_RELEASE_SIGNING_KEY < ~/.config/eigenenterprise/release-signing.pem"
else
  echo "✓ backup private key: $KEY"
  echo "✓ backup public key embedded in ee/src/release-key.ts and ee/install.sh — commit them"
  echo
  echo "!! This backup key must NOT go to CI or GitHub secrets — never 'gh secret set' it."
  echo "!! Move it offline now (password manager / USB stick), then delete the local copy:"
  echo
  echo "     rm $KEY"
  echo
  echo "!! It is only used if the current release key is lost or leaked."
fi
