import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { appContractSchema, assertInCatalog } from './spec.ts'

/**
 * The livekit-server pin lives in scripts/release.sh (which fetches and verifies
 * the upstream binary) and ee/install.sh (which fetches the packed release).
 * These checks keep the two in step and the pin real: an exact version and the
 * sha256 LiveKit publishes for it (github.com/livekit/livekit/releases, checksums.txt).
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const releaseSh = read('../../scripts/release.sh')
const installSh = read('../install.sh')
const value = (text: string, name: string) => new RegExp(`^${name}="?([^"\\s]+)"?$`, 'm').exec(text)?.[1]

describe('the pinned livekit-server', () => {
  it('release.sh pins an exact version', () => {
    expect(value(releaseSh, 'LIVEKIT_VERSION')).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('release.sh pins the published sha256 of each linux tarball', () => {
    expect(value(releaseSh, 'LIVEKIT_SHA256_amd64')).toBe('1e9ee90ca301e1842b2887fc77cb122759756a9c8aeb4334ee91de3325ec43fb')
    expect(value(releaseSh, 'LIVEKIT_SHA256_arm64')).toBe('2af6ce091d6b3c79d1677f8ff1bbb91a8007f40b2325c059b52d38383c0830b6')
    expect(value(releaseSh, 'LIVEKIT_VERSION')).toBe('1.13.11')
  })

  it('release.sh verifies the download against the pin before packing it', () => {
    expect(releaseSh).toMatch(/sha256sum -c/)
  })

  it('install.sh fetches the same version release.sh packs', () => {
    expect(value(installSh, 'LIVEKIT_VERSION')).toBe(value(releaseSh, 'LIVEKIT_VERSION'))
  })

  it('the contract packed with it is a valid system-only binary contract', () => {
    const c = appContractSchema.parse(JSON.parse(read('../livekit/ee.json')))
    expect(c).toMatchObject({ runtime: 'binary', start: ['./livekit-server'], health: '/' })
    expect(() => assertInCatalog(c, 'system')).not.toThrow()
  })
})
