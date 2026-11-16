/**
 * Signed releases (plan/phase-managed-box.md M5): every published release carries
 * `SHA256SUMS` (sha256 of each asset) and `SHA256SUMS.sig` (base64 Ed25519 signature
 * of SHA256SUMS by the project's release key). Only a manifest signed by the key
 * embedded here is trusted; `ee upgrade` and install.sh refuse anything else.
 *
 * The key between the markers is written by scripts/release-key.sh — do not edit by hand.
 */

import { createHash, createPublicKey, verify } from 'node:crypto'

// BEGIN RELEASE PUBLIC KEY (written by scripts/release-key.sh)
export const RELEASE_PUBLIC_KEY_PEM = 'PLACEHOLDER: no release signing key yet'
// END RELEASE PUBLIC KEY

export const NO_KEY_MESSAGE = 'this build has no release signing key (run scripts/release-key.sh)'

/** True only when `signatureBase64` is the Ed25519 signature of `manifest` by the given key. */
export function verifyReleaseManifest(manifest: string, signatureBase64: string, publicKeyPem: string = RELEASE_PUBLIC_KEY_PEM): boolean {
  if (!publicKeyPem.includes('-----BEGIN PUBLIC KEY-----')) throw new Error(NO_KEY_MESSAGE)
  const key = createPublicKey(publicKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`the release key is ${key.asymmetricKeyType}, not ed25519`)
  const sig = Buffer.from(signatureBase64.trim(), 'base64')
  if (sig.length !== 64) return false
  return verify(null, Buffer.from(manifest, 'utf8'), key, sig)
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
export function trustedManifest(manifest: string, signatureBase64: string, publicKeyPem: string = RELEASE_PUBLIC_KEY_PEM) {
  if (!verifyReleaseManifest(manifest, signatureBase64, publicKeyPem)) {
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
