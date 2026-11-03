import { describe, expect, it } from 'vitest'
import { assertRepoPath, extensionDataPrefix, LAYOUT, LayoutError, slugify } from './layout'
import { parseSystem, readSystemPin, serializeSystem, SystemFileError } from './system'

const c = (n: string) => n.repeat(40)

describe('system.yaml', () => {
  const pin = {
    core: { release: '0.4.0', commit: c('a') },
    extensions: [
      { id: 'zeta', version: '1.0.0', commit: c('b') },
      { id: 'alpha', version: '2.1.0', commit: c('c') },
    ],
    apps: [{ name: 'shop', source: 'github.com/acme/shop', commit: c('d') }],
  }

  it('canonical: format/version stamped, lists sorted, round trip identical', () => {
    const text = serializeSystem(pin)
    expect(text).toBe(serializeSystem({ ...pin, extensions: [...pin.extensions].reverse() }))
    expect(text.startsWith('apps:\n')).toBe(true)
    expect(text).toContain('format: eigen.system\n')
    const parsed = parseSystem(text)
    expect(parsed.extensions.map((e) => e.id)).toEqual(['alpha', 'zeta'])
    expect(serializeSystem(parsed)).toBe(text)
  })

  it('refuses newer versions, bad commits and duplicates loudly', () => {
    expect(() => parseSystem(serializeSystem(pin).replace(/^version: 1$/m, 'version: 2'))).toThrow(
      /newer installer/,
    )
    expect(() => serializeSystem({ ...pin, core: { release: '0.4.0', commit: 'abc' } })).toThrow(
      SystemFileError,
    )
    expect(() =>
      serializeSystem({ ...pin, extensions: [pin.extensions[0]!, pin.extensions[0]!] }),
    ).toThrow(/twice/)
  })

  it('reader for the restore path', async () => {
    const text = serializeSystem(pin)
    expect(
      await readSystemPin(async (p) => (p === 'system.yaml' ? Buffer.from(text) : null)),
    ).toEqual(parseSystem(text))
    expect(await readSystemPin(async () => null)).toBeNull()
  })
})

describe('layout contract', () => {
  it('refuses escaping paths and reserves extensions/<id>/', () => {
    expect(() => assertRepoPath('../x')).toThrow(LayoutError)
    expect(() => assertRepoPath('.git/config')).toThrow(LayoutError)
    expect(() => assertRepoPath('/abs')).toThrow(LayoutError)
    expect(assertRepoPath('groups/sales.yaml')).toBe('groups/sales.yaml')
    expect(extensionDataPrefix('crm')).toBe('extensions/crm/')
    expect(() => extensionDataPrefix('../x')).toThrow(LayoutError)
    expect(LAYOUT.extensions).toBe('extensions/')
    expect(slugify('Sales & Marketing — Ünited!')).toBe('sales-marketing-united')
    expect(slugify('!!!')).toBe('untitled')
  })
})
