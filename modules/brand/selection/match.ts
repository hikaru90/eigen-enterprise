import type { BrandCorpusItem } from '../style-format/corpus'
import type { FontClass } from '../style-format/fonts'
import { converter } from 'culori'
import {
  FONT_CLASS_ORDER,
  styleDistance,
  styleVector,
  VECTOR_ROLES,
  type OklchTriple,
  type StyleVector,
  type VectorRole,
} from '../style-format/vector'

/**
 * Selection math for the taste-elicitation wizard (phase-2d M4, V7 — pure,
 * zero LLM): the taste profile is the weighted centroid of the picked style
 * cards' vectors (equal weights in v0) and the shortlist is the ranked list
 * of nearest corpus designs by styleDistance. Everything is deterministic:
 * same picks -> same centroid -> same ranking (ties broken by item id).
 */

/** Vector lookup keyed by corpus item id (see buildStyleVectorIndex). */
export type StyleVectorIndex = ReadonlyMap<string, StyleVector>

/** Precompute the style vectors for a corpus once; match() is then pure lookup + math. */
export function buildStyleVectorIndex(items: readonly BrandCorpusItem[]): StyleVectorIndex {
  const index = new Map<string, StyleVector>()
  for (const item of items) index.set(item.id, styleVector(item))
  return index
}

/** The wizard unlocks "show matches" at 3 picks (V7). */
export const MIN_SELECTION_PICKS = 3
/** Upper bound on picks entering the centroid (schema-enforced too). */
export const MAX_SELECTION_PICKS = 12
/** Top-N shortlist size (V7: top-3 nearest corpus designs). */
export const DEFAULT_MATCH_LIMIT = 3

export type CentroidMatch = { item: BrandCorpusItem; distance: number }

const toOkLab = converter('oklab')
const toOkLch = converter('oklch')

/** Mean color in OKLab space (perceptually even), converted back to OKLCH. */
function meanColor(triples: readonly OklchTriple[]): OklchTriple {
  let l = 0
  let a = 0
  let b = 0
  for (const triple of triples) {
    const lab = toOkLab({ mode: 'oklch', ...triple })
    if (!lab || lab.l === undefined) throw new Error('centroid color conversion failed')
    l += lab.l
    a += lab.a ?? 0
    b += lab.b ?? 0
  }
  const n = triples.length
  const lch = toOkLch({ mode: 'oklab', l: l / n, a: a / n, b: b / n })
  if (!lch || lch.l === undefined) throw new Error('centroid color conversion failed')
  return { l: lch.l, c: lch.c ?? 0, h: lch.h ?? 0 } // c ?? 0, h ?? 0: achromatic hue pinned to 0
}

/** Majority class per font slot; ties break in FONT_CLASS_ORDER (pinned, deterministic). */
function majorityClass(classes: readonly FontClass[]): FontClass {
  const counts = new Map<FontClass, number>()
  for (const cls of classes) counts.set(cls, (counts.get(cls) ?? 0) + 1)
  let best = FONT_CLASS_ORDER[0]!
  let bestCount = -1
  for (const cls of FONT_CLASS_ORDER) {
    const count = counts.get(cls) ?? 0
    if (count > bestCount) {
      best = cls
      bestCount = count
    }
  }
  return best
}

/**
 * Equal-weight centroid of the picked vectors (v0 weighting). Categorical
 * font slots take the majority class; numeric dimensions take the mean.
 */
export function centroidVector(vectors: readonly StyleVector[]): StyleVector {
  if (vectors.length === 0) {
    throw new Error('centroidVector: no vectors — pick at least one style card first')
  }
  const n = vectors.length
  const mean = (get: (v: StyleVector) => number) => vectors.reduce((s, v) => s + get(v), 0) / n
  const colors = Object.fromEntries(
    VECTOR_ROLES.map((role) => [role, meanColor(vectors.map((v) => v.colors[role]))]),
  ) as Record<VectorRole, OklchTriple>
  return {
    colors,
    radius: mean((v) => v.radius),
    spacing: mean((v) => v.spacing),
    fontClasses: {
      sans: majorityClass(vectors.map((v) => v.fontClasses.sans)),
      display: majorityClass(vectors.map((v) => v.fontClasses.display)),
      mono: majorityClass(vectors.map((v) => v.fontClasses.mono)),
    },
    weightSet: mean((v) => v.weightSet) >= 0.5 ? 1 : 0,
    darkDelta: mean((v) => v.darkDelta),
    grain: mean((v) => v.grain),
    elevation: mean((v) => v.elevation),
  }
}

/**
 * Rank the corpus by styleDistance from the picked items' centroid, nearest
 * first, picked items excluded, top `limit` (default 3) returned. Fails loud
 * when fewer than MIN_SELECTION_PICKS ids are given (the UI unlocks at >=3),
 * on duplicates, or on unknown picked ids.
 */
export function centroidMatch(
  index: StyleVectorIndex,
  items: readonly BrandCorpusItem[],
  pickedIds: readonly string[],
  opts: { limit?: number } = {},
): CentroidMatch[] {
  if (pickedIds.length < MIN_SELECTION_PICKS) {
    throw new Error(
      `selection needs at least ${MIN_SELECTION_PICKS} picks to compute a taste profile; got ${pickedIds.length}`,
    )
  }
  if (new Set(pickedIds).size !== pickedIds.length) {
    throw new Error('duplicate picked ids — each style card may be picked once')
  }
  const limit = opts.limit ?? DEFAULT_MATCH_LIMIT
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`match limit must be a positive integer, got: ${limit}`)
  }
  const centroid = centroidVector(
    pickedIds.map((id) => {
      const vector = index.get(id)
      if (!vector) throw new Error(`picked item ${id} is not in the corpus vector index`)
      return vector
    }),
  )
  const picked = new Set(pickedIds)
  return items
    .filter((item) => !picked.has(item.id))
    .map((item) => {
      const vector = index.get(item.id)
      if (!vector) throw new Error(`corpus item ${item.id} is missing from the vector index`)
      return { item, distance: styleDistance(centroid, vector) }
    })
    .sort((a, b) => a.distance - b.distance || (a.item.id < b.item.id ? -1 : 1))
    .slice(0, limit)
}
