import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  BACKUP_PLACEHOLDER,
  parseSha256Sums,
  RELEASE_BACKUP_PUBLIC_KEY_PEM,
  RELEASE_PUBLIC_KEY_PEM,
  sha256Hex,
  trustedManifest,
  verifyReleaseManifest,
} from './release-key.ts'

// A throwaway keypair: never a real release key in the repo.
const pair = () => generateKeyPairSync('ed25519')
const { publicKey, privateKey } = pair()
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const MANIFEST = `${sha256Hex('eigenenterprise-0.5.0-1bb02b405565\n')}  LATEST\n${sha256Hex('#!/bin/sh\n')}  install.sh\n`
const sigOf = (m: string, key = privateKey) => sign(null, Buffer.from(m), key).toString('base64')

describe('verifyReleaseManifest', () => {
  it('accepts a manifest signed by the key', () => {
    expect(verifyReleaseManifest(MANIFEST, sigOf(MANIFEST), PUB)).toBe(true)
    expect(verifyReleaseManifest(MANIFEST, `${sigOf(MANIFEST)}\n`, PUB)).toBe(true)
  })
  it('rejects a signature by another key', () => {
    expect(verifyReleaseManifest(MANIFEST, sigOf(MANIFEST, pair().privateKey), PUB)).toBe(false)
  })
  it('rejects a tampered manifest', () => {
    expect(verifyReleaseManifest(`${MANIFEST}${'f'.repeat(64)}  extra\n`, sigOf(MANIFEST), PUB)).toBe(false)
  })
  it('rejects garbage signatures', () => {
    expect(verifyReleaseManifest(MANIFEST, '', PUB)).toBe(false)
    expect(verifyReleaseManifest(MANIFEST, 'not-a-signature', PUB)).toBe(false)
  })
  it('fails loud with the placeholder key', () => {
    expect(() => verifyReleaseManifest(MANIFEST, sigOf(MANIFEST), 'PLACEHOLDER: no release signing key yet')).toThrow(
      'this build has no release signing key (run scripts/release-key.sh)',
    )
  })
  it('the embedded key is the placeholder or a real Ed25519 key, never something else', () => {
    if (RELEASE_PUBLIC_KEY_PEM.startsWith('PLACEHOLDER')) {
      expect(() => verifyReleaseManifest(MANIFEST, sigOf(MANIFEST))).toThrow(/no release signing key/)
    } else {
      expect(verifyReleaseManifest(MANIFEST, sigOf(MANIFEST))).toBe(false)
    }
  })
  it('refuses a non-Ed25519 key', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()
    expect(() => verifyReleaseManifest(MANIFEST, sigOf(MANIFEST), rsa)).toThrow(/not ed25519/)
  })
})

describe('the backup release key (plan/phase-upgrades.md §6.2)', () => {
  const backup = pair()
  const BACKUP_PUB = backup.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  it('trusts the set {current, backup}: either signature passes, any other key fails', () => {
    expect(verifyReleaseManifest(MANIFEST, sigOf(MANIFEST), PUB, BACKUP_PUB)).toBe(true)
    expect(verifyReleaseManifest(MANIFEST, sigOf(MANIFEST, backup.privateKey), PUB, BACKUP_PUB)).toBe(true)
    expect(verifyReleaseManifest(MANIFEST, sigOf(MANIFEST, pair().privateKey), PUB, BACKUP_PUB)).toBe(false)
    expect(() => trustedManifest(MANIFEST, sigOf(MANIFEST, backup.privateKey), PUB, BACKUP_PUB)).not.toThrow()
  })
  it('skips the placeholder backup: only the current key is trusted', () => {
    expect(verifyReleaseManifest(MANIFEST, sigOf(MANIFEST), PUB, BACKUP_PLACEHOLDER)).toBe(true)
    expect(verifyReleaseManifest(MANIFEST, sigOf(MANIFEST, backup.privateKey), PUB, BACKUP_PLACEHOLDER)).toBe(false)
  })
  it('the backup never replaces the current key: a missing current key still fails loud', () => {
    expect(() => verifyReleaseManifest(MANIFEST, sigOf(MANIFEST, backup.privateKey), 'PLACEHOLDER: no release signing key yet', BACKUP_PUB)).toThrow(
      'this build has no release signing key (run scripts/release-key.sh)',
    )
  })
  it('refuses a backup that is neither the placeholder nor a PEM, a non-Ed25519 backup, and a backup equal to the current key', () => {
    expect(() => verifyReleaseManifest(MANIFEST, sigOf(MANIFEST), PUB, '')).toThrow(/backup release key/)
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()
    expect(() => verifyReleaseManifest(MANIFEST, sigOf(MANIFEST), PUB, rsa)).toThrow(/not ed25519/)
    expect(() => verifyReleaseManifest(MANIFEST, sigOf(MANIFEST), PUB, PUB)).toThrow(/backup release key is the current key/)
  })
  it('the embedded backup is the placeholder or a real Ed25519 key distinct from the current one', () => {
    if (RELEASE_BACKUP_PUBLIC_KEY_PEM === BACKUP_PLACEHOLDER) return
    expect(RELEASE_BACKUP_PUBLIC_KEY_PEM).toContain('-----BEGIN PUBLIC KEY-----')
    expect(RELEASE_BACKUP_PUBLIC_KEY_PEM).not.toBe(RELEASE_PUBLIC_KEY_PEM)
    expect(verifyReleaseManifest(MANIFEST, sigOf(MANIFEST))).toBe(false)
  })
})

describe('parseSha256Sums', () => {
  it('reads "<hex>  <name>" lines (sha256sum and shasum output)', () => {
    const sums = parseSha256Sums(`${'a'.repeat(64)}  ee.mjs\n${'b'.repeat(64)} *x.tar.gz\n\n`)
    expect([...sums]).toEqual([
      ['ee.mjs', 'a'.repeat(64)],
      ['x.tar.gz', 'b'.repeat(64)],
    ])
  })
  it('refuses malformed lines, paths and duplicates', () => {
    expect(() => parseSha256Sums('nope  ee.mjs')).toThrow(/line 1/)
    expect(() => parseSha256Sums(`${'a'.repeat(64)}  ../etc/passwd`)).toThrow(/line 1/)
    expect(() => parseSha256Sums(`${'a'.repeat(64)}  x\n${'b'.repeat(64)}  x`)).toThrow(/twice/)
  })
})

describe('trustedManifest', () => {
  it('checks files against the signed manifest', () => {
    const m = trustedManifest(MANIFEST, sigOf(MANIFEST), PUB)
    expect(() => m.check('install.sh', sha256Hex('#!/bin/sh\n'))).not.toThrow()
    expect(() => m.check('install.sh', sha256Hex('#!/bin/sh\nevil\n'))).toThrow(/checksum mismatch for install.sh/)
    expect(() => m.check('ee.mjs', sha256Hex(''))).toThrow(/does not list ee.mjs/)
  })
  it('refuses an unsigned manifest', () => {
    expect(() => trustedManifest(MANIFEST, sigOf(MANIFEST, pair().privateKey), PUB)).toThrow(/not signed/)
  })
})
