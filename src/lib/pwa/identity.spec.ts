import { describe, expect, it } from 'vitest'
import { identityColors, identityTokens, parseIconVariant } from './identity'

const brand = {
  '--primary': 'oklch(0.536 0.14 250)',
  '--primary-foreground': 'oklch(0.985 0.014 250)',
  '--background': 'oklch(0.962 0.012 250)',
}

describe('identityTokens', () => {
  it("is the company's monogram on the active brand's colors", () => {
    const t = identityTokens('kindred Digital Labs', brand)
    expect(t).toMatchObject({
      name: 'kindred Digital Labs',
      initial: 'K',
      primary: brand['--primary'],
      primaryForeground: brand['--primary-foreground'],
      background: brand['--background'],
    })
    expect(t.version).toMatch(/^[0-9a-z]+$/)
  })

  it("uses the app's own colors without an active brand (the shell's own badge colors)", () => {
    expect(identityTokens('Acme', null)).toMatchObject({
      initial: 'A',
      primary: '#111111',
      primaryForeground: '#ffffff',
      background: '#e8ede5',
    })
  })

  it('is the product until the company has a name', () => {
    expect(identityTokens(null, brand)).toMatchObject({ name: 'eigenEnterprise', initial: null })
  })

  it('takes the first character, not half of one', () => {
    expect(identityTokens('Ölwerk', null).initial).toBe('Ö')
    expect(identityTokens('𝔸lpha', null).initial).toBe('𝔸')
  })

  it('a new name or new brand colors give a new version (installed icons refresh), the same ones do not', () => {
    const v = identityTokens('Acme', brand).version
    expect(identityTokens('Acme', brand).version).toBe(v)
    expect(identityTokens('Acme Inc', brand).version).not.toBe(v)
    expect(identityTokens('Acme', { ...brand, '--primary': 'oklch(0.5 0.2 30)' }).version).not.toBe(v)
  })
})

describe('identityColors', () => {
  it('turns the brand tokens into hex for icons and the manifest', () => {
    expect(identityColors(identityTokens('Acme', null))).toEqual({
      tile: '#111111',
      glyph: '#ffffff',
      background: '#e8ede5',
    })
    const c = identityColors(identityTokens('Acme', brand))
    for (const v of Object.values(c)) expect(v).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('fails loudly on a brand token that is not a color', () => {
    expect(() => identityColors(identityTokens('Acme', { ...brand, '--primary': 'var(--x)' }))).toThrow(
      /--primary .*not a color/,
    )
  })
})

describe('parseIconVariant', () => {
  it('knows the icons the manifest and the page link to', () => {
    expect(parseIconVariant('any-192.png')).toEqual({ kind: 'any', size: 192 })
    expect(parseIconVariant('any-512.png')).toEqual({ kind: 'any', size: 512 })
    expect(parseIconVariant('maskable-512.png')).toEqual({ kind: 'maskable', size: 512 })
    expect(parseIconVariant('apple-180.png')).toEqual({ kind: 'apple', size: 180 })
    expect(parseIconVariant('favicon-32.png')).toEqual({ kind: 'any', size: 32 })
  })

  it('refuses anything else', () => {
    expect(parseIconVariant('any-4096.png')).toBeNull()
    expect(parseIconVariant('../secrets')).toBeNull()
  })
})
