import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateCorpusItem } from '../style-format/corpus'
import { styleVector, type StyleVector } from '../style-format/vector'
import {
  DISTINCTNESS_THRESHOLD,
  checkSiblingDistinctness,
  findNearDuplicates,
  siblingGroupsOf,
} from './distinct'
import { parseTaxonomyDraft } from './schema'

const here = import.meta.dirname
const load = (slug: string): StyleVector =>
  styleVector(validateCorpusItem(JSON.parse(readFileSync(join(here, '../corpus/items', `${slug}.json`), 'utf8'))))

describe('checkSiblingDistinctness', () => {
  const a = load('archetype-editorial-serif')
  const b = load('archetype-luxury-serif') // measured 0.094 from editorial-serif
  const c = load('daisyui-cyberpunk')

  it('flags sibling pairs closer than the threshold, sorted by distance then ids', () => {
    const report = checkSiblingDistinctness(
      [{ parentId: 'p', children: [{ id: 'z', vector: a }, { id: 'y', vector: b }, { id: 'x', vector: c }] }],
      0.2,
    )
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]).toMatchObject({ parentId: 'p', a: 'y', b: 'z' })
    expect(report.violations[0]!.distance).toBeCloseTo(0.0943, 3)
    expect(report.measuredPairs).toBe(3)
    expect(report.unmeasured).toEqual([])
  })

  it('reports children without a vector as unmeasured, never as passing', () => {
    const report = checkSiblingDistinctness(
      [{ parentId: 'p', children: [{ id: 'a', vector: a }, { id: 'n', vector: null }] }],
      0.2,
    )
    expect(report.violations).toEqual([])
    expect(report.measuredPairs).toBe(0)
    expect(report.unmeasured).toEqual([{ parentId: 'p', id: 'n' }])
  })

  it('is deterministic regardless of group/child input order', () => {
    const g1 = { parentId: 'p1', children: [{ id: 'a', vector: a }, { id: 'b', vector: b }] }
    const g2 = { parentId: 'p0', children: [{ id: 'd', vector: b }, { id: 'c', vector: a }] }
    const r1 = checkSiblingDistinctness([g1, g2], 0.2)
    const r2 = checkSiblingDistinctness([{ ...g2, children: [...g2.children].reverse() }, g1], 0.2)
    expect(r1).toEqual(r2)
    expect(r1.violations.map((v) => v.parentId)).toEqual(['p0', 'p1'])
  })

  it('fails loud on a non-finite or out-of-range threshold', () => {
    expect(() => checkSiblingDistinctness([], Number.NaN)).toThrow(/threshold/)
    expect(() => checkSiblingDistinctness([], 1.5)).toThrow(/threshold/)
  })

  it('fails loud on duplicate child ids within a group', () => {
    expect(() =>
      checkSiblingDistinctness([{ parentId: 'p', children: [{ id: 'a', vector: a }, { id: 'a', vector: c }] }], 0.2),
    ).toThrow(/duplicate child id "a"/)
  })
})

describe('findNearDuplicates', () => {
  it('lists corpus pairs under the threshold, closest first', () => {
    const items = ['archetype-editorial-serif', 'archetype-luxury-serif', 'daisyui-cyberpunk'].map((slug) => ({ slug, vector: load(slug) }))
    const pairs = findNearDuplicates(items, 0.2)
    expect(pairs.map((p) => [p.a, p.b])).toEqual([['archetype-editorial-serif', 'archetype-luxury-serif']])
  })
})

describe('siblingGroupsOf', () => {
  it('builds root/genre/style groups and resolves the first mapped slug as the representative', () => {
    const draft = parseTaxonomyDraft(JSON.parse(readFileSync(join(here, 'draft.json'), 'utf8')))
    const resolved: string[] = []
    const groups = siblingGroupsOf(draft, (slug) => {
      resolved.push(slug)
      return load(slug)
    })
    const styleCount = draft.genres.reduce((n, g) => n + g.styles.length, 0)
    expect(groups).toHaveLength(1 + draft.genres.length + styleCount)
    expect(groups[0]!.parentId).toBe('root')
    expect(groups[0]!.children.map((c) => c.id)).toEqual(draft.genres.map((g) => g.id))
    expect(resolved.length).toBeGreaterThan(0)
  })
})

describe('DISTINCTNESS_THRESHOLD', () => {
  it('is pinned at the measured corpus gap (see distinct.ts)', () => {
    expect(DISTINCTNESS_THRESHOLD).toBe(0.2)
  })
})
