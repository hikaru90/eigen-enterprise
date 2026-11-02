import { describe, expect, it } from 'vitest'
import { loadPickerIndex, parsePickerIndex, pickerIndexSourceFromEnv, toVisualSetVars } from './load-index'
import fixture from './test-fixtures/picker-fixture.json'

const clone = () => JSON.parse(JSON.stringify(fixture)) as { version: number; nodes: Record<string, unknown>[] }

describe('picker index loader', () => {
  it('parses the fixture into a navigable tree (2 genres × 2 styles × 2 variants)', () => {
    const tree = parsePickerIndex(fixture, 'fixture')
    expect(tree.children(null).map((n) => n.id)).toEqual(['swiss-minimal', 'editorial-serif'])
    expect(tree.children('swiss-minimal').map((n) => n.id)).toEqual(['swiss-grid', 'swiss-soft'])
    expect(tree.children('swiss-grid').map((n) => n.id)).toEqual(['swiss-grid-red', 'swiss-grid-blue'])
    expect(tree.nodes.filter((n) => n.level === 'variant')).toHaveLength(8)
    expect(tree.trail('swiss-grid-blue').map((n) => n.id)).toEqual(['swiss-minimal', 'swiss-grid', 'swiss-grid-blue'])
    expect(tree.get('nope')).toBeNull()
  })

  it('fails loud on a schema violation, naming the source', () => {
    const bad = clone()
    delete (bad.nodes[0]!.tokens as { light: Record<string, string> }).light.primary
    expect(() => parsePickerIndex(bad, 'fixture')).toThrow(/fixture.*primary/s)
  })

  it('fails loud when a node has no preview (requirePreviews)', () => {
    const bad = clone()
    delete bad.nodes[3]!.preview
    expect(() => parsePickerIndex(bad, 'fixture')).toThrow(/node "swiss-grid-blue" has no preview/)
  })

  it('fails loud on a structural error (orphan parent)', () => {
    const bad = clone()
    bad.nodes[2]!.parentId = 'ghost'
    expect(() => parsePickerIndex(bad, 'fixture')).toThrow(/unknown parent "ghost"/)
  })

  it('loads the fixture source and refuses a missing built index loud', () => {
    expect(loadPickerIndex('fixture').children(null)).toHaveLength(2)
    // picker-index.json is written by the renderer (B2b); until then the built source must not silently degrade.
    if (!loadPickerIndex.hasBuiltIndex()) {
      expect(() => loadPickerIndex('built')).toThrow(/picker-index\.json is missing/)
    }
  })

  it('reads the source from BRAND_PICKER_INDEX, rejecting unknown values', () => {
    expect(pickerIndexSourceFromEnv(undefined)).toBe('built')
    expect(pickerIndexSourceFromEnv('fixture')).toBe('fixture')
    expect(() => pickerIndexSourceFromEnv('other')).toThrow(/BRAND_PICKER_INDEX/)
  })

  it('maps a token set to visual-set cssVars (bare role → --role)', () => {
    expect(toVisualSetVars({ primary: '#fff', radius: '0rem' })).toEqual({ '--primary': '#fff', '--radius': '0rem' })
  })
})
