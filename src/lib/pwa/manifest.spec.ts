import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { identityColors, identityTokens } from './identity'
import { webAppManifest } from './manifest'

const staticDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../static')

const brand = {
  '--primary': '#5b2a6e',
  '--primary-foreground': '#ffffff',
  '--background': '#faf6ee',
}
const manifestFor = (name: string | null, cssVars: Record<string, string> | null) => {
  const tokens = identityTokens(name, cssVars)
  return webAppManifest(tokens, identityColors(tokens))
}

describe('webAppManifest', () => {
  it('installs as a standalone app that opens on Messages', () => {
    const m = manifestFor('Kindred Digital Labs', brand)
    expect(m.display).toBe('standalone')
    expect(m.start_url).toBe('/messages')
    expect(m.scope).toBe('/')
    expect(m.id).toBe('/')
  })

  it('is named after the company, with the product name until it has one', () => {
    expect(manifestFor('Kindred Digital Labs', brand)).toMatchObject({
      name: 'Kindred Digital Labs',
      short_name: 'Kindred Digital Labs',
    })
    expect(manifestFor(null, null)).toMatchObject({ name: 'eigenEnterprise', short_name: 'eigenEnterprise' })
  })

  it("wears the company's brand: its monogram icons (versioned) and its background color", () => {
    const tokens = identityTokens('Kindred', brand)
    const m = webAppManifest(tokens, identityColors(tokens))
    expect(m.icons).toEqual([
      { src: `/app-icon/any-192.png?v=${tokens.version}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `/app-icon/any-512.png?v=${tokens.version}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `/app-icon/maskable-512.png?v=${tokens.version}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ])
    expect(m).toMatchObject({ theme_color: '#faf6ee', background_color: '#faf6ee' })
  })

  it('an unnamed company gets the product icons, and every one of them exists', () => {
    const m = manifestFor(null, null)
    expect(m.icons.map((i) => `${i.sizes} ${i.purpose}`)).toEqual(['192x192 any', '512x512 any', '512x512 maskable'])
    for (const icon of m.icons) expect(existsSync(path.join(staticDir, icon.src))).toBe(true)
  })
})
