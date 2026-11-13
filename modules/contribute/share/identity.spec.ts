import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { signHubRequest, verifyHubRequest } from './contract'
import { generateInstallKey, sealedInstallKeyStore } from './identity'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'ee-contribute-key-'))
  dirs.push(d)
  return join(d, 'company-keys')
}

describe('install identity', () => {
  it('makes a random install id and an Ed25519 key the contract signs and verifies with', () => {
    const k = generateInstallKey()
    expect(k.installId).toMatch(/^[0-9a-f-]{36}$/)
    expect(generateInstallKey().installId).not.toBe(k.installId)
    const headers = signHubRequest({ method: 'PUT', path: '/x', body: '{}', installId: k.installId, privateKey: k.privateKey, now: 1000 })
    expect(verifyHubRequest({ method: 'PUT', path: '/x', body: '{}', headers, publicKey: k.publicKey, now: 1000 })).toEqual({ ok: true, installId: k.installId })
  })

  it('seals the key on disk: round trip, never in clear, wrong master key fails, a different key is refused', async () => {
    const dir = await tmp()
    const store = sealedInstallKeyStore(dir, 'master-1')
    expect(await store.load()).toBeNull()
    const k = generateInstallKey()
    await store.save(k)
    expect(await store.load()).toEqual(k)
    const onDisk = await readFile(join(dir, 'contribute-install.sealed'), 'utf8')
    expect(onDisk).not.toContain(k.privateKey)
    expect(onDisk).not.toContain(k.installId)
    await store.save(k)
    await expect(store.save(generateInstallKey())).rejects.toThrow(/refusing to replace/)
    await expect(sealedInstallKeyStore(dir, 'master-2').load()).rejects.toThrow()
    expect(() => sealedInstallKeyStore(dir, ' ').load()).rejects.toThrow(/TENANT_MASTER_KEY/)
  })
})
