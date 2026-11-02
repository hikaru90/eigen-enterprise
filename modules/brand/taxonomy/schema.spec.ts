import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { leavesOf, parseTaxonomyDraft, type TaxonomyDraft } from './schema'

const here = import.meta.dirname
const itemsDir = join(here, '../corpus/items')
const corpusSlugs = new Set(readdirSync(itemsDir).map((f) => f.replace(/\.json$/, '')))

const intent = {
  fonts: { heading: 'Inter', body: 'Inter', mono: 'JetBrains Mono' },
  radius: 'md',
  palette: 'cool neutral, blue accent',
  mode: 'light',
  density: 'regular',
  elevation: 'subtle',
  border: 'hairline',
  motion: 'productive',
} as const

function variant(id: string, source: unknown = { kind: 'author' }) {
  return { id, name: id, description: `${id} desc`, axes: ['colour-mood'], intent, source }
}

function minimal(): TaxonomyDraft {
  return {
    version: 1,
    status: 'proposal',
    sources: [{ id: 'daisyui', name: 'daisyUI', url: 'https://daisyui.com', licence: 'MIT', use: 'tokens' }],
    genres: [
      {
        id: 'g-a',
        name: 'A',
        description: 'genre a',
        axes: ['type-pairing'],
        intent,
        source: { kind: 'author' },
        styles: [
          {
            id: 'g-a-s1',
            name: 'S1',
            description: 's1',
            axes: ['density'],
            intent,
            source: { kind: 'author' },
            variants: [variant('g-a-s1-v1', { kind: 'corpus', slugs: ['daisyui-light'] }), variant('g-a-s1-v2')],
          },
          {
            id: 'g-a-s2',
            name: 'S2',
            description: 's2',
            axes: ['density'],
            intent,
            source: { kind: 'author' },
            variants: [variant('g-a-s2-v1'), variant('g-a-s2-v2')],
          },
        ],
      },
      {
        id: 'g-b',
        name: 'B',
        description: 'genre b',
        axes: ['type-pairing'],
        intent,
        source: { kind: 'author' },
        styles: [
          {
            id: 'g-b-s1',
            name: 'S1',
            description: 's1',
            axes: ['density'],
            intent,
            source: { kind: 'author' },
            variants: [variant('g-b-s1-v1'), variant('g-b-s1-v2')],
          },
          {
            id: 'g-b-s2',
            name: 'S2',
            description: 's2',
            axes: ['density'],
            intent,
            source: { kind: 'author' },
            variants: [variant('g-b-s2-v1'), variant('g-b-s2-v2')],
          },
        ],
      },
    ],
  }
}

describe('taxonomy draft schema', () => {
  it('accepts a well-formed draft and lists its leaves', () => {
    const draft = parseTaxonomyDraft(minimal())
    expect(leavesOf(draft).map((l) => l.id)).toEqual(['g-a-s1-v1', 'g-a-s1-v2', 'g-a-s2-v1', 'g-a-s2-v2', 'g-b-s1-v1', 'g-b-s1-v2', 'g-b-s2-v1', 'g-b-s2-v2'])
  })

  it('rejects duplicate node ids anywhere in the tree', () => {
    const d = minimal()
    d.genres[1]!.styles[0]!.variants[0]!.id = 'g-a-s1-v1'
    expect(() => parseTaxonomyDraft(d)).toThrow(/duplicate node id "g-a-s1-v1"/)
  })

  it('rejects non-slug ids', () => {
    const d = minimal()
    d.genres[0]!.id = 'Genre A'
    expect(() => parseTaxonomyDraft(d)).toThrow(/invalid taxonomy draft/)
  })

  it('rejects a corpus slug mapped to two leaves', () => {
    const d = minimal()
    d.genres[1]!.styles[0]!.variants[0]!.source = { kind: 'corpus', slugs: ['daisyui-light'] }
    expect(() => parseTaxonomyDraft(d)).toThrow(/corpus item "daisyui-light" mapped to more than one leaf/)
  })

  it('rejects a node without distinguishing axes', () => {
    const d = minimal()
    d.genres[0]!.styles[0]!.axes = []
    expect(() => parseTaxonomyDraft(d)).toThrow(/invalid taxonomy draft/)
  })

  it('rejects a parent with a single child (nothing to choose between)', () => {
    const d = minimal()
    d.genres[0]!.styles[0]!.variants.pop()
    expect(() => parseTaxonomyDraft(d)).toThrow(/invalid taxonomy draft/)
  })

  it('rejects an unknown axis', () => {
    const d = minimal() as unknown as { genres: { axes: string[] }[] }
    d.genres[0]!.axes = ['vibes']
    expect(() => parseTaxonomyDraft(d)).toThrow(/invalid taxonomy draft/)
  })
})

describe('draft.json (the B1 proposal)', () => {
  const draft = parseTaxonomyDraft(JSON.parse(readFileSync(join(here, 'draft.json'), 'utf8')))
  const leaves = leavesOf(draft)

  it('stays inside the plan envelope (8-12 genres, 4-8 styles, 3-4 variants, 150-300 leaves)', () => {
    expect(draft.genres.length).toBeGreaterThanOrEqual(8)
    expect(draft.genres.length).toBeLessThanOrEqual(12)
    for (const g of draft.genres) {
      expect(g.styles.length, g.id).toBeGreaterThanOrEqual(4)
      expect(g.styles.length, g.id).toBeLessThanOrEqual(8)
      for (const s of g.styles) {
        expect(s.variants.length, s.id).toBeGreaterThanOrEqual(3)
        expect(s.variants.length, s.id).toBeLessThanOrEqual(4)
      }
    }
    expect(leaves.length).toBeGreaterThanOrEqual(150)
    expect(leaves.length).toBeLessThanOrEqual(300)
  })

  it('maps only to corpus items that exist', () => {
    const all = [...draft.genres, ...draft.genres.flatMap((g) => g.styles), ...leaves]
    const missing = all.flatMap((n) => (n.source.kind === 'corpus' ? n.source.slugs : [])).filter((s) => !corpusSlugs.has(s))
    expect(missing).toEqual([])
  })

  it('every source reference names a recorded source', () => {
    const ids = new Set(draft.sources.map((s) => s.id))
    expect(draft.sources.length).toBeGreaterThan(0)
    for (const s of draft.sources) expect(ids.has(s.id)).toBe(true)
  })
})
