import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { pickerIndexSchema, type PickerNode } from '../picker-index'
import {
  buildPickerIndex,
  copyForGenre,
  DEFAULT_COPY,
  genreIdOf,
  previewDocuments,
  previewHash,
  renderPreviewHtml,
} from './index'

const fixture = JSON.parse(
  readFileSync(new URL('../test-fixtures/mini-styles.json', import.meta.url), 'utf8'),
)
const nodes: PickerNode[] = pickerIndexSchema.parse(fixture).nodes
const byId = new Map(nodes.map((n) => [n.id, n]))
const peach = byId.get('saas-soft-peach')!

describe('renderPreviewHtml', () => {
  it('lands the mode tokens as CSS variables', () => {
    const light = renderPreviewHtml(peach, 'light', copyForGenre('saas'))
    const dark = renderPreviewHtml(peach, 'dark', copyForGenre('saas'))
    expect(light).toContain(`--primary:${peach.tokens.light.primary}`)
    expect(light).toContain(`--bg:${peach.tokens.light.background}`)
    expect(dark).toContain(`--primary:${peach.tokens.dark.primary}`)
    expect(dark).toContain('color-scheme:dark')
  })

  it('loads the node fonts from Google Fonts and uses them', () => {
    const html = renderPreviewHtml(byId.get('editorial-fashion-cobalt')!, 'light', DEFAULT_COPY)
    expect(html).toContain('https://fonts.googleapis.com/css2?family=Bodoni+Moda')
    expect(html).toContain('family=JetBrains+Mono')
    expect(html).toContain('family=Montserrat')
    expect(html).toContain("--fh:'Bodoni Moda'")
  })

  it('maps shape to radius/border/elevation/density', () => {
    expect(renderPreviewHtml(peach, 'light', DEFAULT_COPY)).toMatch(/--sh:0 4px 10px.*--r:999px/s)
    const tabloid = renderPreviewHtml(
      byId.get('editorial-newspaper-tabloid')!,
      'light',
      DEFAULT_COPY,
    )
    expect(tabloid).toContain('--bw:2.5px')
    expect(tabloid).toContain('--r:0px')
    expect(tabloid).toContain('--d:0.75')
    expect(tabloid).toContain('--sh:none')
  })

  it('uses per-genre copy, escaped, and is deterministic', () => {
    expect(genreIdOf(peach, byId)).toBe('saas')
    const html = renderPreviewHtml(peach, 'light', { ...copyForGenre('saas'), heading: '<b>x</b>' })
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(renderPreviewHtml(peach, 'light', copyForGenre('saas'))).toContain(
      'Ship your roadmap faster',
    )
    expect(copyForGenre('unknown-genre')).toBe(DEFAULT_COPY)
    const a = previewDocuments(nodes).map((d) => previewHash(d.html))
    expect(previewDocuments(nodes).map((d) => previewHash(d.html))).toEqual(a)
    expect(new Set(a).size).toBe(nodes.length * 2)
  })
})

describe('buildPickerIndex', () => {
  it('adds preview paths and validates with requirePreviews', () => {
    const index = buildPickerIndex(fixture)
    expect(index.nodes).toHaveLength(14)
    expect(index.nodes[0].preview).toEqual({
      light: '/brand-previews/saas-light.webp',
      dark: '/brand-previews/saas-dark.webp',
    })
    expect(JSON.stringify(buildPickerIndex(fixture))).toBe(JSON.stringify(index))
  })

  it('fails loud on structural errors', () => {
    const broken = {
      version: 1,
      nodes: fixture.nodes.filter((n: PickerNode) => n.id !== 'saas-bento'),
    }
    expect(() => buildPickerIndex(broken)).toThrow(/unknown parent "saas-bento"/)
  })
})
