#!/bin/sh
# Generate the eigenEnterprise release signing key (Ed25519) — once, by the owner
# (plan/phase-managed-box.md M5).
#
#   scripts/release-key.sh
#
# Writes the private key to ~/.config/eigenenterprise/release-signing.pem (0600,
# never overwritten), embeds the public key in ee/src/release-key.ts and
# ee/install.sh (between the "BEGIN/END RELEASE PUBLIC KEY" markers), and prints
# the command that hands the private key to the release workflow.
# Needs OpenSSL 3 or newer (raw Ed25519); macOS's LibreSSL is not enough (brew install openssl@3).
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DIR="$HOME/.config/eigenenterprise"
KEY="$DIR/release-signing.pem"
TS="$ROOT/ee/src/release-key.ts"
SH="$ROOT/ee/install.sh"

[ ! -e "$KEY" ] || { echo "✗ $KEY already exists — refusing to overwrite the release key" >&2; exit 1; }
for f in "$TS" "$SH"; do
  grep -q '^// BEGIN RELEASE PUBLIC KEY\|^# BEGIN RELEASE PUBLIC KEY' "$f" || { echo "✗ no BEGIN RELEASE PUBLIC KEY marker in $f" >&2; exit 1; }
done
openssl version | grep -Eq '^OpenSSL ([3-9]|[1-9][0-9]+)\.' || { echo "✗ needs OpenSSL 3 or newer (found: $(openssl version))" >&2; exit 1; }

mkdir -p "$DIR" && chmod 700 "$DIR"
(umask 077 && openssl genpkey -algorithm ed25519 -out "$KEY")
chmod 600 "$KEY"
PUB=$(openssl pkey -in "$KEY" -pubout)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# Replace the lines strictly between the markers with the file $1 holds.
splice() { # splice <replacement-file> <target>
  awk -v repl="$1" '
    /^(\/\/|#) BEGIN RELEASE PUBLIC KEY/ { print; while ((getline line < repl) > 0) print line; skip = 1; next }
    /^(\/\/|#) END RELEASE PUBLIC KEY/ { skip = 0 }
    !skip { print }
  ' "$2" > "$TMP/out" && cat "$TMP/out" > "$2"
}
{ printf 'export const RELEASE_PUBLIC_KEY_PEM = `%s\n`\n' "$PUB"; } > "$TMP/ts"
{ printf "  cat <<'PEM'\n%s\nPEM\n" "$PUB"; } > "$TMP/sh"
splice "$TMP/ts" "$TS"
splice "$TMP/sh" "$SH"

echo "✓ private key: $KEY (keep it safe; it signs every release)"
echo "✓ public key embedded in ee/src/release-key.ts and ee/install.sh — commit them"
echo
echo "Now give the release workflow the private key:"
echo
echo "  gh secret set EE_RELEASE_SIGNING_KEY < ~/.config/eigenenterprise/release-signing.pem"
