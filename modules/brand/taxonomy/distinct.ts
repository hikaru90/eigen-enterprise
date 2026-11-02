import { styleDistance, type StyleVector } from '../style-format/vector'
import type { TaxonomyDraft, TaxonomyNode } from './schema'

/**
 * Distinctness gate (plan/phase-brand-picker.md §3.1): siblings must be at
 * least DISTINCTNESS_THRESHOLD apart under the existing styleDistance.
 *
 * Threshold choice (measured 2026-11-02 over the 83 corpus items, 3403 pairs):
 * all-pairs p5 = 0.450, median 0.507; nearest-neighbour p10 = 0.186,
 * median 0.450. The colour component saturates at a mean OKLab ΔE of 0.1, so
 * any real palette change alone already yields ≥ 0.45 — the low tail is items
 * that share a palette family. The nearest-neighbour distribution has its
 * clearest gap between 0.190 (tweakcn bold-tech ↔ clean-slate) and 0.232
 * (quantum-rose ↔ t3-chat); 0.20 sits in that gap and flags 7 corpus pairs (9 items, ≈ the bottom
 * 10% of nearest neighbours) as near-duplicates.
 *
 * Nodes without a vector (to be authored in B2) are reported as unmeasured —
 * never counted as passing.
 */
export const DISTINCTNESS_THRESHOLD = 0.2

export type MeasuredChild = { id: string; vector: StyleVector | null }
export type SiblingGroup = { parentId: string; children: MeasuredChild[] }
export type DistinctnessViolation = { parentId: string; a: string; b: string; distance: number }
export type DistinctnessReport = {
  threshold: number
  measuredPairs: number
  violations: DistinctnessViolation[]
  unmeasured: { parentId: string; id: string }[]
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6
const byId = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0)

function assertThreshold(threshold: number): void {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
    throw new Error(`distinctness threshold must be in (0, 1), got ${threshold}`)
  }
}

export function checkSiblingDistinctness(groups: SiblingGroup[], threshold: number): DistinctnessReport {
  assertThreshold(threshold)
  const violations: DistinctnessViolation[] = []
  const unmeasured: { parentId: string; id: string }[] = []
  let measuredPairs = 0
  const sortedGroups = [...groups].sort((g, h) => byId(g.parentId, h.parentId))
  for (const group of sortedGroups) {
    const ids = new Set<string>()
    for (const c of group.children) {
      if (ids.has(c.id)) throw new Error(`distinctness: duplicate child id "${c.id}" under "${group.parentId}"`)
      ids.add(c.id)
    }
    const children = [...group.children].sort((x, y) => byId(x.id, y.id))
    for (const c of children) if (c.vector === null) unmeasured.push({ parentId: group.parentId, id: c.id })
    const measured = children.filter((c): c is { id: string; vector: StyleVector } => c.vector !== null)
    for (let i = 0; i < measured.length; i++) {
      for (let j = i + 1; j < measured.length; j++) {
        measuredPairs++
        const distance = round6(styleDistance(measured[i]!.vector, measured[j]!.vector))
        if (distance < threshold) {
          violations.push({ parentId: group.parentId, a: measured[i]!.id, b: measured[j]!.id, distance })
        }
      }
    }
  }
  violations.sort((v, w) => byId(v.parentId, w.parentId) || v.distance - w.distance || byId(v.a, w.a) || byId(v.b, w.b))
  return { threshold, measuredPairs, violations, unmeasured }
}

export type NearDuplicate = { a: string; b: string; distance: number }

/** All corpus pairs closer than the threshold, closest first (ties by slug). */
export function findNearDuplicates(items: { slug: string; vector: StyleVector }[], threshold: number): NearDuplicate[] {
  assertThreshold(threshold)
  const sorted = [...items].sort((x, y) => byId(x.slug, y.slug))
  const out: NearDuplicate[] = []
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const distance = round6(styleDistance(sorted[i]!.vector, sorted[j]!.vector))
      if (distance < threshold) out.push({ a: sorted[i]!.slug, b: sorted[j]!.slug, distance })
    }
  }
  return out.sort((v, w) => v.distance - w.distance || byId(v.a, w.a) || byId(v.b, w.b))
}

/**
 * Sibling groups of a draft: root (genres), each genre (styles), each style
 * (variants). A node's representative vector is its FIRST mapped corpus slug;
 * "author" nodes are unmeasured until B2 authors their tokens.
 */
export function siblingGroupsOf(draft: TaxonomyDraft, resolve: (slug: string) => StyleVector): SiblingGroup[] {
  const measure = (n: TaxonomyNode): MeasuredChild => ({
    id: n.id,
    vector: n.source.kind === 'corpus' ? resolve(n.source.slugs[0]!) : null,
  })
  return [
    { parentId: 'root', children: draft.genres.map(measure) },
    ...draft.genres.map((g) => ({ parentId: g.id, children: g.styles.map(measure) })),
    ...draft.genres.flatMap((g) => g.styles.map((s) => ({ parentId: s.id, children: s.variants.map(measure) }))),
  ]
}
