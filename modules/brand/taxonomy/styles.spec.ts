import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { siblingGroupsOfNodes } from './authoring/build'
import { contrastFailures } from './authoring/derive'
import { checkSiblingDistinctness, DISTINCTNESS_THRESHOLD } from './distinct'
import { pickerIndexSchema, validatePickerNodes } from './picker-index'

/**
 * Gates over the committed styles.json (brand picker B2a): schema, tree
 * structure, WCAG AA contrast in both themes, and sibling distinctness over
 * EVERY node (genres, styles, variants — all measurable now).
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const index = pickerIndexSchema.parse(JSON.parse(readFileSync(path.join(here, 'styles.json'), 'utf8')))

describe('styles.json (brand picker B2a)', () => {
  it('is schema-valid and structurally complete (no previews yet)', () => {
    expect(validatePickerNodes(index.nodes, { requirePreviews: false })).toEqual([])
    expect(index.nodes.every((n) => n.preview === undefined)).toBe(true)
  })

  it('has the owner-approved shape: 11 genres, every style with 2–4 variants', () => {
    const genres = index.nodes.filter((n) => n.level === 'genre')
    expect(genres).toHaveLength(11)
    for (const s of index.nodes.filter((n) => n.level === 'style')) {
      const count = index.nodes.filter((n) => n.parentId === s.id).length
      expect(count, s.id).toBeGreaterThanOrEqual(2)
      expect(count, s.id).toBeLessThanOrEqual(4)
    }
  })

  it('keeps fonts and font tokens in sync', () => {
    for (const n of index.nodes) {
      for (const set of [n.tokens.light, n.tokens.dark]) {
        expect(set['font-display']!.startsWith(`"${n.fonts.heading}"`), n.id).toBe(true)
        expect(set['font-sans']!.startsWith(`"${n.fonts.body}"`), n.id).toBe(true)
        expect(set['font-mono']!.startsWith(`"${n.fonts.mono}"`), n.id).toBe(true)
      }
    }
  })

  it('reaches WCAG AA 4.5:1 for every text/fill pair in light and dark', () => {
    const failures = index.nodes.flatMap((n) =>
      (['light', 'dark'] as const).flatMap((mode) => contrastFailures(n.tokens[mode]).map((f) => ({ id: n.id, mode, ...f }))),
    )
    expect(failures).toEqual([])
  })

  it('keeps every sibling pair at least DISTINCTNESS_THRESHOLD apart (all nodes measured)', () => {
    const report = checkSiblingDistinctness(siblingGroupsOfNodes(index.nodes), DISTINCTNESS_THRESHOLD)
    expect(report.unmeasured).toEqual([])
    expect(report.violations).toEqual([])
  })
})
