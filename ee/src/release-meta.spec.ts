import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { sha256Hex, trustedManifest } from './release-key.ts'
import { fetchReleaseMeta, legacyMeta, loadMeta, metaDir, parseMeta, storeMeta, versionGate } from './release-meta.ts'

const KEY = generateKeyPairSync('ed25519')
const PEM = KEY.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const NEW = 'eigenenterprise-0.5.41-aaaaaaaaaaaa'
const META = JSON.stringify({ release: NEW, downgradeFloor: '0.5.40', minFrom: '0.5.20', capabilities: ['chromium'], later: 'ignored' })
const signed = (sums: string) => ({ sums, sig: sign(null, Buffer.from(sums), KEY.privateKey).toString('base64') })
const manifestWith = (files: Record<string, string>) => {
  const { sums, sig } = signed(Object.entries(files).map(([n, c]) => `${sha256Hex(c)}  ${n}\n`).join(''))
  return { sums, sig, manifest: trustedManifest(sums, sig, PEM) }
}

describe('fetchReleaseMeta: the signed UPGRADE.json of a release', () => {
  it('reads the floor, minFrom and capabilities, checked against the signed manifest (unknown fields ignored)', async () => {
    const { manifest } = manifestWith({ 'UPGRADE.json': META })
    const { meta } = await fetchReleaseMeta({ fetchText: async () => META }, 'https://r', manifest, NEW)
    expect(meta).toEqual({ release: NEW, version: '0.5.41', downgradeFloor: '0.5.40', minFrom: '0.5.20', capabilities: ['chromium'], legacy: false })
  })

  it('refuses an UPGRADE.json that is not the signed one', async () => {
    const { manifest } = manifestWith({ 'UPGRADE.json': META })
    await expect(fetchReleaseMeta({ fetchText: async () => META.replace('0.5.40', '0.5.20') }, 'https://r', manifest, NEW)).rejects.toThrow(/checksum mismatch for UPGRADE\.json/)
  })

  it('refuses a release since 0.5.40 that carries none', async () => {
    const { manifest } = manifestWith({ LATEST: `${NEW}\n` })
    await expect(fetchReleaseMeta({ fetchText: async () => '' }, 'https://r', manifest, NEW)).rejects.toThrow(/carries no signed UPGRADE\.json .* since 0\.5\.40 must/)
  })

  it('takes an older release as floor = its own version, with no minFrom', async () => {
    const { manifest } = manifestWith({ LATEST: 'x' })
    const { meta } = await fetchReleaseMeta({ fetchText: async () => '' }, 'https://r', manifest, 'eigenenterprise-0.5.39-bbbbbbbbbbbb')
    expect(meta).toMatchObject({ downgradeFloor: '0.5.39', minFrom: null, capabilities: [], legacy: true })
  })

  it('refuses metadata of another release or with a floor above the release', () => {
    expect(() => parseMeta(META, 'eigenenterprise-0.5.42-aaaaaaaaaaaa')).toThrow(/describes eigenenterprise-0\.5\.41/)
    expect(() => parseMeta(JSON.stringify({ ...JSON.parse(META), downgradeFloor: '0.6.0' }), NEW)).toThrow(/floor 0\.6\.0 is newer/)
  })
})

describe('versionGate: minFrom forward, the downgrade floor back', () => {
  const meta = (v: string, floor = v, minFrom: string | null = null) => ({ ...legacyMeta(`eigenenterprise-${v}-aaaaaaaaaaaa`), downgradeFloor: floor, minFrom, legacy: false })
  it('lets a server at or above minFrom upgrade', () => {
    expect(versionGate(meta('0.5.30'), meta('0.5.41', '0.5.41', '0.5.20'))).toBeNull()
    expect(versionGate(null, meta('0.5.41', '0.5.41', '0.5.20'))).toBeNull()
  })
  it('refuses a jump from below minFrom with a sentence', () => {
    expect(versionGate(meta('0.5.10'), meta('0.5.41', '0.5.41', '0.5.20'))).toMatch(/runs 0\.5\.20 or newer; this one runs 0\.5\.10/)
  })
  it('lets a server go back to its floor, never below', () => {
    expect(versionGate(meta('0.5.41', '0.5.39'), meta('0.5.39'))).toBeNull()
    expect(versionGate(meta('0.5.41', '0.5.40'), meta('0.5.39'))).toMatch(/0\.5\.39 is below the downgrade floor 0\.5\.40/)
  })
  it('an older release with no kept metadata cannot be left backwards at all', () => {
    expect(versionGate(legacyMeta('eigenenterprise-0.5.39-aaaaaaaaaaaa'), meta('0.5.38'))).toMatch(/below the downgrade floor 0\.5\.39/)
  })
})

describe('kept metadata: stored next to the tarball, verified again on read', () => {
  function files() {
    const m = new Map<string, string>()
    return { m, io: { readFile: async (p: string) => m.get(p) ?? null, writeFile: async (p: string, c: string) => void m.set(p, c), mkdirp: async () => undefined } }
  }
  it('round-trips a verified copy', async () => {
    const { io } = files()
    const { sums, sig } = manifestWith({ 'UPGRADE.json': META })
    await storeMeta(io, NEW, { sums, sig, meta: META })
    expect(await loadMeta(io, NEW, PEM)).toMatchObject({ downgradeFloor: '0.5.40', legacy: false })
  })
  it('a release ee keeps nothing for is legacy (floor = itself)', async () => {
    expect(await loadMeta(files().io, NEW, PEM)).toMatchObject({ downgradeFloor: '0.5.41', legacy: true })
  })
  it('fails loud on a kept copy that was changed', async () => {
    const { io, m } = files()
    const { sums, sig } = manifestWith({ 'UPGRADE.json': META })
    await storeMeta(io, NEW, { sums, sig, meta: META })
    m.set(`${metaDir(NEW)}/UPGRADE.json`, META.replace('0.5.40', '0.5.20'))
    await expect(loadMeta(io, NEW, PEM)).rejects.toThrow(/does not verify: checksum mismatch/)
  })
})
