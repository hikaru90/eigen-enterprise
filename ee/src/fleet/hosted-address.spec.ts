import { describe, expect, it, vi } from 'vitest'
import { readHostedAddress, writeHostedAddress, type HostedAddressFiles } from './hosted-address.ts'

const PATH = '/var/lib/ee/fleet-hosted-address.json'
const hostedAddress = { mailDomain: 'acme.eigenenterprise.app', siteHost: 'www.acme.eigenenterprise.app' }

function files(initial?: string) {
  const store = new Map<string, string>(initial === undefined ? [] : [[PATH, initial]])
  const f = {
    readFile: async (p: string) => store.get(p) ?? null,
    writeFile: vi.fn(async (p: string, c: string) => void store.set(p, c)),
    remove: vi.fn(async (p: string) => void store.delete(p)),
  }
  return { f: f as HostedAddressFiles & typeof f, store }
}

describe('fleet hosted address store (plan/hosted-address.md H5)', () => {
  it('no file reads as nothing received and nothing added by the fleet', async () => {
    expect(await readHostedAddress(files().f, PATH)).toEqual({ hostedAddress: null, fleetSiteHost: null })
  })

  it('writes a versioned file through the atomic write, only on change', async () => {
    const { f, store } = files()
    const record = { hostedAddress, fleetSiteHost: hostedAddress.siteHost }
    expect(await writeHostedAddress(f, PATH, record)).toBe(true)
    expect(JSON.parse(store.get(PATH)!)).toEqual({ version: 1, ...record })
    expect(await readHostedAddress(f, PATH)).toEqual(record)
    expect(await writeHostedAddress(f, PATH, record)).toBe(false)
    expect(f.writeFile).toHaveBeenCalledTimes(1)
    expect(await writeHostedAddress(f, PATH, { hostedAddress, fleetSiteHost: null })).toBe(true)
    expect(await readHostedAddress(f, PATH)).toEqual({ hostedAddress, fleetSiteHost: null })
  })

  it('nothing to keep removes the file, once', async () => {
    const { f, store } = files(JSON.stringify({ version: 1, hostedAddress, fleetSiteHost: null }))
    expect(await writeHostedAddress(f, PATH, { hostedAddress: null, fleetSiteHost: null })).toBe(true)
    expect(store.has(PATH)).toBe(false)
    expect(await writeHostedAddress(f, PATH, { hostedAddress: null, fleetSiteHost: null })).toBe(false)
    expect(f.remove).toHaveBeenCalledTimes(1)
  })

  it('a broken file fails loudly, naming it, and is never silently replaced (it holds provenance)', async () => {
    const { f } = files('{"version":1,"hostedAddress":{"mailDomain":"x"}}')
    await expect(readHostedAddress(f, PATH)).rejects.toThrow(PATH)
    await expect(readHostedAddress(files('not json').f, PATH)).rejects.toThrow(/not JSON/)
    await expect(writeHostedAddress(f, PATH, { hostedAddress, fleetSiteHost: null })).rejects.toThrow(PATH)
    expect(f.writeFile).not.toHaveBeenCalled()
  })
})
