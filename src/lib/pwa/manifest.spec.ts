import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { webAppManifest } from './manifest'

const staticDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../static')

describe('webAppManifest', () => {
  it('installs as a standalone app that opens on Messages', () => {
    const m = webAppManifest('Kindred Digital Labs')
    expect(m.display).toBe('standalone')
    expect(m.start_url).toBe('/messages')
    expect(m.scope).toBe('/')
    expect(m.id).toBe('/')
  })

  it('is named after the company, with the product name until it has one', () => {
    expect(webAppManifest('Kindred Digital Labs')).toMatchObject({
      name: 'Kindred Digital Labs',
      short_name: 'Kindred Digital Labs',
    })
    expect(webAppManifest(null)).toMatchObject({ name: 'eigenEnterprise', short_name: 'eigenEnterprise' })
  })

  it('has any + maskable icons at 192 and 512, and every icon file exists', () => {
    const m = webAppManifest(null)
    expect(m.icons.map((i) => `${i.sizes} ${i.purpose}`)).toEqual(
      expect.arrayContaining(['192x192 any', '512x512 any', '512x512 maskable']),
    )
    for (const icon of m.icons) expect(existsSync(path.join(staticDir, icon.src))).toBe(true)
  })
})
