import { describe, expect, it, vi } from 'vitest'
import { readClaims, writeClaims, type ClaimFiles } from './claims.ts'

const PATH = '/var/lib/ee/fleet-claims.json'
const claims = [{ host: 'www.acme.com', verified: false, txtName: '_ee-verify.www.acme.com', txtValue: 'company-token' }]

function files(initial?: string) {
  const store = new Map<string, string>(initial === undefined ? [] : [[PATH, initial]])
  const f = {
    readFile: async (p: string) => store.get(p) ?? null,
    writeFile: vi.fn(async (p: string, c: string) => void store.set(p, c)),
    remove: vi.fn(async (p: string) => void store.delete(p)),
  }
  return { f: f as ClaimFiles & typeof f, store }
}

describe('fleet claims store', () => {
  it('no file reads as null', async () => {
    expect(await readClaims(files().f, PATH)).toBeNull()
  })

  it('writes a versioned file through the atomic write, only when the claims changed', async () => {
    const { f, store } = files()
    expect(await writeClaims(f, PATH, claims)).toBe(true)
    expect(JSON.parse(store.get(PATH)!)).toEqual({ version: 1, claims })
    expect(await readClaims(f, PATH)).toEqual(claims)
    expect(await writeClaims(f, PATH, claims)).toBe(false)
    expect(f.writeFile).toHaveBeenCalledTimes(1)
    expect(await writeClaims(f, PATH, [])).toBe(true)
    expect(await readClaims(f, PATH)).toEqual([])
  })

  it('null removes the file, once', async () => {
    const { f, store } = files(JSON.stringify({ version: 1, claims }))
    expect(await writeClaims(f, PATH, null)).toBe(true)
    expect(store.has(PATH)).toBe(false)
    expect(await writeClaims(f, PATH, null)).toBe(false)
    expect(f.remove).toHaveBeenCalledTimes(1)
  })

  it('a broken file fails a read loudly, naming it; the next poll replaces it', async () => {
    const { f } = files('{"version":1,"claims":[{"host":"x"}]}')
    await expect(readClaims(f, PATH)).rejects.toThrow(PATH)
    await expect(readClaims(files('not json').f, PATH)).rejects.toThrow(/not JSON/)
    expect(await writeClaims(f, PATH, claims)).toBe(true)
    expect(await readClaims(f, PATH)).toEqual(claims)
  })
})
