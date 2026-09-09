import type { BrandCorpusItem } from '../style-format/corpus'
import { describe, expect, it } from 'vitest'
import { brandSeedsSchema } from '../style-format/seeds'
import { styleDistance, styleVector } from '../style-format/vector'
import { adjacentClusters, similarItems, type NavigationIndex } from './navigate'

/**
 * Toy fixtures (match.spec.ts pattern): four near-identical pastels, a
 * neutral canvas and a mono terminal — enough to prove ranking, exclusion
 * and fail-loud behavior for the M7 tree navigation lookups.
 */

function seeds(overrides: Partial<Record<string, unknown>> = {}) {
  return brandSeedsSchema.parse({
    seedColor: { l: 0.75, c: 0.06, h: 300 },
    neutralTintHue: 300,
    accentHueShift: null,
    chromaCurve: 'muted',
    darkModeStrategy: 'invert-tone',
    fonts: { fontPrimary: 'Inter', fontSecondary: 'Lora', fontMono: 'Geist Mono' },
    fluidScale: {
      baseSize: { min: 16, max: 18 },
      scaleRatio: { min: 1.125, max: 1.2 },
      viewport: { min: 400, max: 1200 },
      scaleSteps: 4,
      trackingCurve: 'neutral',
    },
    spaceRhythm: [0.25, 0.5, 1, 2],
    shapeCharacter: 'soft',
    radiusBase: '0.75rem',
    elevation: 'flat',
    motionPersonality: 'productive',
    grain: 0,
    ...overrides,
  })
}

function pastel(id: string, name: string, hue: number): BrandCorpusItem {
  return {
    id,
    name,
    seeds: seeds({ seedColor: { l: 0.75, c: 0.06, h: hue }, neutralTintHue: hue }),
    cssVars: {
      '--background': 'oklch(0.985 0.005 300)',
      '--foreground': 'oklch(0.247 0.005 300)',
      '--primary': `oklch(0.75 0.06 ${hue})`,
      '--secondary': `oklch(0.9 0.03 ${hue})`,
      '--accent': `oklch(0.9 0.03 ${hue})`,
      '--muted': 'oklch(0.931 0.005 300)',
      '--border': 'oklch(0.697 0.005 300)',
      '--ring': `oklch(0.75 0.05 ${hue})`,
      '--card': 'oklch(0.985 0.005 300)',
      '--destructive': 'oklch(0.536 0.2 27)',
      '--radius': '0.75rem',
      '--space-1': 'clamp(0.25rem, 0.2rem + 0.025vw, 0.3rem)',
      '--font-sans': '"Inter"',
      '--font-display': '"Lora"',
      '--font-mono': '"Geist Mono"',
    },
    darkCssVars: { '--background': 'oklch(0.13 0.005 300)' },
    provenance: { source: 'archetype' },
    createdAt: '2026-09-09T00:00:00.000Z',
  }
}

const PASTEL_A = pastel('1a000000-0000-4000-8000-00000000000a', 'pastel-a', 290)
const PASTEL_B = pastel('1b000000-0000-4000-8000-00000000000b', 'pastel-b', 300)
const PASTEL_C = pastel('1c000000-0000-4000-8000-00000000000c', 'pastel-c', 310)
const PASTEL_D = pastel('1d000000-0000-4000-8000-00000000000d', 'pastel-d', 320)
const NEUTRAL_CANVAS = pastel('1f000000-0000-4000-8000-00000000000f', 'neutral-canvas', 60)

const MONO_TERMINAL: BrandCorpusItem = {
  id: '1e000000-0000-4000-8000-00000000000e',
  name: 'mono-terminal',
  seeds: seeds({
    seedColor: { l: 0.7, c: 0.02, h: 145 },
    neutralTintHue: 145,
    fonts: { fontPrimary: 'JetBrains Mono', fontSecondary: 'JetBrains Mono', fontMono: 'JetBrains Mono' },
    radiusBase: '0px',
    shapeCharacter: 'sharp',
  }),
  cssVars: {
    '--background': 'oklch(0.985 0.005 145)',
    '--foreground': 'oklch(0.247 0.005 145)',
    '--primary': 'oklch(0.536 0.02 145)',
    '--secondary': 'oklch(0.853 0.01 145)',
    '--accent': 'oklch(0.853 0.01 145)',
    '--muted': 'oklch(0.931 0.005 145)',
    '--border': 'oklch(0.697 0.005 145)',
    '--ring': 'oklch(0.615 0.02 145)',
    '--card': 'oklch(0.985 0.005 145)',
    '--destructive': 'oklch(0.536 0.2 27)',
    '--radius': '0px',
    '--space-1': 'clamp(0.25rem, 0.2rem + 0.025vw, 0.3rem)',
    '--font-sans': '"JetBrains Mono"',
    '--font-display': '"JetBrains Mono"',
    '--font-mono': '"JetBrains Mono"',
  },
  darkCssVars: { '--background': 'oklch(0.13 0.005 145)' },
  provenance: { source: 'archetype' },
  createdAt: '2026-09-09T00:00:00.000Z',
}

const ITEMS = [PASTEL_A, PASTEL_B, PASTEL_C, PASTEL_D, NEUTRAL_CANVAS, MONO_TERMINAL]

const byId = new Map(ITEMS.map((item) => [item.id, item]))
/** knn order as the build would store it: nearest-first, ties by id. */
function knnOf(id: string, k = 5): string[] {
  const self = byId.get(id)!
  return ITEMS
    .filter((item) => item.id !== id)
    .map((item) => ({ id: item.id, dist: styleDistance(styleVector(self), styleVector(item)) }))
    .sort((x, y) => x.dist - y.dist || (x.id < y.id ? -1 : 1))
    .slice(0, k)
    .map((e) => e.id)
}

/** 48-dim toy centroid: parametric ramp so distances stay ordered by seed gap. */
function numericCentroid(seed: number): number[] {
  return Array.from({ length: 48 }, (_, i) => Math.min(0.999, seed + i * 0.001))
}

function toyIndex(): NavigationIndex {
  return {
    knn: Object.fromEntries(ITEMS.map((item) => [item.id, knnOf(item.id)])),
    clusters: [
      {
        id: 'cluster-1',
        name: 'Pastel family',
        memberIds: [PASTEL_A.id, PASTEL_B.id, PASTEL_C.id, PASTEL_D.id],
        centroidVector: numericCentroid(0.1),
        adjacentClusterIds: ['cluster-2', 'cluster-3'],
      },
      {
        id: 'cluster-2',
        name: 'Neutral family',
        memberIds: [NEUTRAL_CANVAS.id],
        centroidVector: numericCentroid(0.4),
        adjacentClusterIds: ['cluster-1', 'cluster-3'],
      },
      {
        id: 'cluster-3',
        name: 'Terminal family',
        memberIds: [MONO_TERMINAL.id],
        centroidVector: numericCentroid(0.7),
        adjacentClusterIds: ['cluster-2', 'cluster-1'],
      },
    ],
  }
}

describe('similarItems (phase-2d M7 k-NN descent)', () => {
  it('ranks the precomputed knn nearest-first with distances, self excluded', () => {
    const similar = similarItems(toyIndex(), ITEMS, PASTEL_A.id)
    expect(similar).toHaveLength(5)
    expect(similar.map((s) => s.item.id)).not.toContain(PASTEL_A.id)
    expect(similar[0]!.item.id).toBe(knnOf(PASTEL_A.id)[0])
    for (let i = 1; i < similar.length; i++) {
      expect(similar[i - 1]!.distance).toBeLessThanOrEqual(similar[i]!.distance)
    }
    // distances are real styleDistance values for the emitted pairs
    expect(similar[0]!.distance).toBe(
      styleDistance(styleVector(PASTEL_A), styleVector(byId.get(similar[0]!.item.id)!)),
    )
  })

  it('the pastel descent never surfaces the terminal as nearer than pastel siblings', () => {
    const similar = similarItems(toyIndex(), ITEMS, PASTEL_A.id)
    const ids = similar.map((s) => s.item.id)
    expect(ids.indexOf(PASTEL_D.id)).toBeLessThan(ids.indexOf(MONO_TERMINAL.id))
  })

  it('honors a limit and fails loud on an invalid one', () => {
    expect(similarItems(toyIndex(), ITEMS, PASTEL_A.id, { limit: 2 })).toHaveLength(2)
    expect(() => similarItems(toyIndex(), ITEMS, PASTEL_A.id, { limit: 0 })).toThrow(/limit/)
    expect(() => similarItems(toyIndex(), ITEMS, PASTEL_A.id, { limit: 1.5 })).toThrow(/limit/)
  })

  it('throws loud on an unknown item id and on a stale knn entry', () => {
    expect(() => similarItems(toyIndex(), ITEMS, '00000000-0000-4000-8000-000000000000')).toThrow(
      /unknown corpus item/,
    )
    const stale = toyIndex()
    stale.knn[PASTEL_A.id] = [...stale.knn[PASTEL_A.id]!.slice(0, 3), '00000000-0000-4000-8000-000000000000']
    expect(() => similarItems(stale, ITEMS, PASTEL_A.id)).toThrow(/stale.*knn|knn.*unknown/i)
  })

  it('is deterministic', () => {
    expect(similarItems(toyIndex(), ITEMS, PASTEL_A.id)).toEqual(similarItems(toyIndex(), ITEMS, PASTEL_A.id))
  })
})

describe('adjacentClusters (phase-2d M7 tunnel links)', () => {
  it('returns the stored tunnels with names and centroid distances, nearest-first', () => {
    const adjacent = adjacentClusters(toyIndex(), 'cluster-1')
    expect(adjacent.map((a) => a.id)).toEqual(['cluster-2', 'cluster-3'])
    expect(adjacent.map((a) => a.name)).toEqual(['Neutral family', 'Terminal family'])
    for (const entry of adjacent) {
      expect(entry.distance).toBeGreaterThanOrEqual(0)
      expect(entry.distance).toBeLessThanOrEqual(1)
    }
    expect(adjacent[0]!.distance).toBeLessThanOrEqual(adjacent[1]!.distance)
  })

  it('recomputes the same ranking the build stored (styleDistance over stored centroids)', () => {
    const index = toyIndex()
    const adjacent = adjacentClusters(index, 'cluster-3')
    const byIdClusters = new Map(index.clusters.map((c) => [c.id, c]))
    const expected = index.clusters
      .find((c) => c.id === 'cluster-3')!
      .adjacentClusterIds.map((id) => byIdClusters.get(id)!)
      .map((cluster) => cluster.id)
    expect(adjacent.map((a) => a.id)).toEqual(expected)
  })

  it('throws loud on an unknown cluster id', () => {
    expect(() => adjacentClusters(toyIndex(), 'cluster-99')).toThrow(/unknown corpus cluster/)
  })
})
