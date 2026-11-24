/**
 * Signed releases (plan/phase-managed-box.md M5): every published release carries
 * `SHA256SUMS` (sha256 of each asset) and `SHA256SUMS.sig` (base64 Ed25519 signature
 * of SHA256SUMS by the project's release key). Only a manifest signed by the key
 * embedded here is trusted; `ee upgrade` and install.sh refuse anything else.
 *
 * Two keys are trusted (plan/phase-upgrades.md §6.2): the current key, which CI signs
 * with, and an offline backup key that is only used if the current one is lost or
 * leaked, so boxes already in the field still accept the next release. The current key
 * is required; the backup may still be BACKUP_PLACEHOLDER ("no backup key yet"), in
 * which case it is skipped and only the current key is trusted.
 *
 * The keys between the markers are written by scripts/release-key.sh (the backup by
 * `scripts/release-key.sh --backup`) — do not edit by hand.
 */

import { createHash, createPublicKey, verify } from 'node:crypto'

// BEGIN RELEASE PUBLIC KEY (written by scripts/release-key.sh)
export const RELEASE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAKvl3XdC1tUoV6fLiwOpijRl2xs92UJmt4rRqvzJPRvA=
-----END PUBLIC KEY-----
`
// END RELEASE PUBLIC KEY

/** The explicit "no backup key yet" value; install.sh's release_backup_public_key prints the same line. */
export const BACKUP_PLACEHOLDER = 'PLACEHOLDER: no backup release key yet (run scripts/release-key.sh --backup)'

// BEGIN RELEASE BACKUP PUBLIC KEY (written by scripts/release-key.sh --backup)
export const RELEASE_BACKUP_PUBLIC_KEY_PEM: string = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAGIdMcsZKnET7Du3YzNCIfWkLkCtean4l5CPv7YzVPko=
-----END PUBLIC KEY-----
`
// END RELEASE BACKUP PUBLIC KEY

export const NO_KEY_MESSAGE = 'this build has no release signing key (run scripts/release-key.sh)'

const PEM_HEADER = '-----BEGIN PUBLIC KEY-----'

function ed25519Key(pem: string, which: string) {
  const key = createPublicKey(pem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`the ${which} is ${key.asymmetricKeyType}, not ed25519`)
  return key
}

/**
 * The trusted key set: the current key (required — a missing one throws NO_KEY_MESSAGE)
 * plus the backup key, unless the backup is exactly BACKUP_PLACEHOLDER (then skipped).
 * A backup that is neither the placeholder nor a PEM, or that equals the current key, throws.
 */
export function trustedReleaseKeys(currentPem: string = RELEASE_PUBLIC_KEY_PEM, backupPem: string = RELEASE_BACKUP_PUBLIC_KEY_PEM) {
  if (!currentPem.includes(PEM_HEADER)) throw new Error(NO_KEY_MESSAGE)
  const keys = [ed25519Key(currentPem, 'release key')]
  if (backupPem === BACKUP_PLACEHOLDER) return keys
  if (!backupPem.includes(PEM_HEADER)) throw new Error(`the backup release key is neither a public key nor the placeholder: ${backupPem.slice(0, 60)}`)
  const backup = ed25519Key(backupPem, 'backup release key')
  if (backup.equals(keys[0]!)) throw new Error('the backup release key is the current key (it must be a second, offline key)')
  keys.push(backup)
  return keys
}

/** True only when `signatureBase64` is the Ed25519 signature of `manifest` by the current or the backup key. */
export function verifyReleaseManifest(
  manifest: string,
  signatureBase64: string,
  publicKeyPem: string = RELEASE_PUBLIC_KEY_PEM,
  backupPublicKeyPem: string = RELEASE_BACKUP_PUBLIC_KEY_PEM,
): boolean {
  const keys = trustedReleaseKeys(publicKeyPem, backupPublicKeyPem)
  const sig = Buffer.from(signatureBase64.trim(), 'base64')
  if (sig.length !== 64) return false
  const data = Buffer.from(manifest, 'utf8')
  return keys.some((key) => verify(null, data, key, sig))
}

/** Parses a `SHA256SUMS` file (`<64 hex>  <name>` per line, `*` binary marker allowed). Throws on any other line. */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const [i, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue
    const m = /^([0-9a-f]{64}) [ *]([^\s/][^/]*)$/.exec(line)
    if (!m) throw new Error(`SHA256SUMS line ${i + 1} is not "<sha256>  <name>": ${line.slice(0, 80)}`)
    const [, hex, name] = m as unknown as [string, string, string]
    if (sums.has(name)) throw new Error(`SHA256SUMS names ${name} twice`)
    sums.set(name, hex)
  }
  return sums
}

export const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

/** The verified manifest, or a plain error. `expect(name, sha)` then checks a file against it. */
export function trustedManifest(
  manifest: string,
  signatureBase64: string,
  publicKeyPem: string = RELEASE_PUBLIC_KEY_PEM,
  backupPublicKeyPem: string = RELEASE_BACKUP_PUBLIC_KEY_PEM,
) {
  if (!verifyReleaseManifest(manifest, signatureBase64, publicKeyPem, backupPublicKeyPem)) {
    throw new Error('the release SHA256SUMS is not signed by the eigenEnterprise release key')
  }
  const sums = parseSha256Sums(manifest)
  return {
    sums,
    check(name: string, actualSha256: string) {
      const want = sums.get(name)
      if (!want) throw new Error(`the signed SHA256SUMS does not list ${name}`)
      if (want !== actualSha256) throw new Error(`checksum mismatch for ${name} (not the signed release)`)
    },
  }
}
