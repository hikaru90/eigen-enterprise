import { describe, expect, it } from 'vitest'
import { assertRepoPath, extensionDataPrefix, LAYOUT, LayoutError, slugify } from './layout'
import { canonicalYaml } from './canonical'
import { parseSystem, pinSystemModule, readSystemPin, serializeSystem, SystemFileError } from './system'

const c = (n: string) => n.repeat(40)
const s = (n: string) => n.repeat(64)

describe('system.yaml', () => {
  const pin = {
    core: { release: '0.4.0', commit: c('a') },
    modules: [
      { id: 'zeta', version: '1.0.0', commit: c('b'), bundleSha256: s('1') },
      { id: 'alpha', version: '2.1.0', commit: c('c'), bundleSha256: s('2') },
    ],
    apps: [{ name: 'shop', source: 'github.com/acme/shop', commit: c('d') }],
  }

  it('v2 canonical: format/version stamped, lists sorted, round trip identical', () => {
    const text = serializeSystem(pin)
    expect(text).toBe(serializeSystem({ ...pin, modules: [...pin.modules].reverse() }))
    expect(text.startsWith('apps:\n')).toBe(true)
    expect(text).toContain('format: eigen.system\n')
    expect(text).toMatch(/^version: 2$/m)
    const parsed = parseSystem(text)
    expect(parsed.modules.map((e) => e.id)).toEqual(['alpha', 'zeta'])
    expect(parsed.modules[0]!.bundleSha256).toBe(s('2'))
    expect(serializeSystem(parsed)).toBe(text)
  })

  it('a v1 file still reads: extensions become modules without a bundle', () => {
    const v1 = canonicalYaml({
      format: 'eigen.system',
      version: 1,
      core: pin.core,
      extensions: [{ id: 'crm', version: '1.2.0', commit: c('e') }],
      apps: [],
    })
    expect(parseSystem(v1)).toEqual({
      core: pin.core,
      modules: [{ id: 'crm', version: '1.2.0', commit: c('e'), bundleSha256: null }],
      apps: [],
    })
    // Writing it back as v2 needs every module's bundle.
    expect(() => serializeSystem(parseSystem(v1))).toThrow(/no bundleSha256/)
  })

  it('pins and unpins one module, keeping the rest; core may be absent until the installer writes it', () => {
    const first = pinSystemModule(null, 'hello', { version: '0.1.0', commit: c('f'), bundleSha256: s('3') })
    expect(parseSystem(first)).toEqual({
      modules: [{ id: 'hello', version: '0.1.0', commit: c('f'), bundleSha256: s('3') }],
      apps: [],
    })
    const both = pinSystemModule(serializeSystem(pin), 'hello', { version: '0.1.0', commit: c('f'), bundleSha256: s('3') })
    expect(parseSystem(both).modules.map((m) => m.id)).toEqual(['alpha', 'hello', 'zeta'])
    expect(parseSystem(both).core).toEqual(pin.core)
    expect(parseSystem(pinSystemModule(both, 'hello', null)).modules.map((m) => m.id)).toEqual(['alpha', 'zeta'])
  })

  it('refuses newer versions, bad commits and duplicates loudly', () => {
    expect(() => parseSystem(serializeSystem(pin).replace(/^version: 2$/m, 'version: 3'))).toThrow(
      /newer installer/,
    )
    expect(() => serializeSystem({ ...pin, core: { release: '0.4.0', commit: 'abc' } })).toThrow(
      SystemFileError,
    )
    expect(() => serializeSystem({ ...pin, modules: [pin.modules[0]!, pin.modules[0]!] })).toThrow(/twice/)
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
