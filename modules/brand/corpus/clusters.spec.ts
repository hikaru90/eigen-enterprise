import type { BrandCorpusItem } from '../style-format/corpus'
import { describe, expect, it } from 'vitest'
import { brandSeedsSchema } from '../style-format/seeds'
import { fromNumericVector, styleDistance, styleVector, type StyleVector } from '../style-format/vector'
import { ADJACENT_CLUSTERS_K, adjacentClusterIdsFor, clusterCorpus, knnFor } from './clusters'

function seeds(h: number, c: number, radius: string, shape: 'sharp' | 'soft' | 'pill' | 'squircle', fonts: Record<string, string>) {
  return brandSeedsSchema.parse({
    seedColor: { l: 0.6, c, h },
    neutralTintHue: h,
    accentHueShift: null,
    chromaCurve: 'flat',
    darkModeStrategy: 'invert-tone',
    fonts: { fontPrimary: fonts.sans, fontSecondary: fonts.display, fontMono: fonts.mono },
    fluidScale: {
      baseSize: { min: 16, max: 18 },
      scaleRatio: { min: 1.125, max: 1.2 },
      viewport: { min: 400, max: 1200 },
      scaleSteps: 4,
      trackingCurve: 'neutral',
    },
    spaceRhythm: [0.25, 0.5, 1, 2],
    shapeCharacter: shape,
    radiusBase: radius,
    elevation: 'flat',
    motionPersonality: 'productive',
    grain: 0,
  })
}

let uuidCounter = 0
function uuid(): string {
  uuidCounter += 1
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`
}

/** Toy item generator: palette + hue/chroma drive color, radius+shape drive shape, fonts drive typography. */
function toy(name: string, opts: { palette: Record<string, string>; h: number; c: number; radius: string; shape: 'sharp' | 'soft' | 'pill' | 'squircle'; sans: string; display: string; mono: string }): BrandCorpusItem {
  const vars: Record<string, string> = {
    ...opts.palette,
    '--primary': `oklch(0.55 ${opts.c} ${opts.h})`,
    '--secondary': `oklch(0.85 ${opts.c * 0.4} ${opts.h})`,
    '--accent': `oklch(0.85 ${opts.c * 0.4} ${opts.h})`,
    '--ring': `oklch(0.6 ${opts.c * 0.8} ${opts.h})`,
    '--destructive': 'oklch(0.55 0.2 27)',
    '--radius': opts.radius,
    '--space-1': 'clamp(0.25rem, 0.2rem + 0.025vw, 0.3rem)',
    '--font-sans': `"${opts.sans}"`,
    '--font-display': `"${opts.display}"`,
    '--font-mono': `"${opts.mono}"`,
  }
  return {
    id: uuid(),
    name,
    seeds: seeds(opts.h, opts.c, opts.radius, opts.shape, { sans: opts.sans, display: opts.display, mono: opts.mono }),
    cssVars: vars,
    darkCssVars: {},
    provenance: { source: 'archetype' },
    createdAt: '2026-09-09T00:00:00.000Z',
  }
}

const pastelPalette = {
  '--background': 'oklch(1 0 0)',
  '--foreground': 'oklch(0.25 0.01 300)',
  '--muted': 'oklch(0.93 0.01 300)',
  '--border': 'oklch(0.9 0.01 300)',
  '--card': 'oklch(0.98 0.005 300)',
}
const terminalPalette = {
  '--background': 'oklch(0.13 0.005 145)',
  '--foreground': 'oklch(0.9 0.005 145)',
  '--muted': 'oklch(0.2 0.005 145)',
  '--border': 'oklch(0.28 0.005 145)',
  '--card': 'oklch(0.16 0.005 145)',
}
const editorialPalette = {
  '--background': 'oklch(0.94 0.03 70)',
  '--foreground': 'oklch(0.25 0.03 50)',
  '--muted': 'oklch(0.88 0.03 70)',
  '--border': 'oklch(0.8 0.04 70)',
  '--card': 'oklch(0.92 0.035 70)',
}

/** Fixed toy corpus: 3 pastel-soft sans, 3 dark mono terminals, 3 warm serif editorials — pairwise far apart. */
function toyCorpus(): BrandCorpusItem[] {
  return [
    toy('pastel a', { palette: pastelPalette, h: 300, c: 0.14, radius: '0.75rem', shape: 'soft', sans: 'Inter', display: 'Inter', mono: 'Geist Mono' }),
    toy('pastel b', { palette: pastelPalette, h: 315, c: 0.15, radius: '0.75rem', shape: 'soft', sans: 'Inter', display: 'Inter', mono: 'Geist Mono' }),
    toy('pastel c', { palette: pastelPalette, h: 290, c: 0.13, radius: '0.8rem', shape: 'soft', sans: 'Inter', display: 'Inter', mono: 'Geist Mono' }),
    toy('terminal a', { palette: terminalPalette, h: 145, c: 0.03, radius: '0px', shape: 'sharp', sans: 'JetBrains Mono', display: 'JetBrains Mono', mono: 'JetBrains Mono' }),
    toy('terminal b', { palette: terminalPalette, h: 160, c: 0.04, radius: '0px', shape: 'sharp', sans: 'JetBrains Mono', display: 'JetBrains Mono', mono: 'JetBrains Mono' }),
    toy('terminal c', { palette: terminalPalette, h: 130, c: 0.03, radius: '0px', shape: 'sharp', sans: 'JetBrains Mono', display: 'JetBrains Mono', mono: 'JetBrains Mono' }),
    toy('editorial a', { palette: editorialPalette, h: 30, c: 0.16, radius: '0.125rem', shape: 'sharp', sans: 'Lora', display: 'Lora', mono: 'IBM Plex Mono' }),
    toy('editorial b', { palette: editorialPalette, h: 45, c: 0.17, radius: '0.125rem', shape: 'sharp', sans: 'Lora', display: 'Lora', mono: 'IBM Plex Mono' }),
    toy('editorial c', { palette: editorialPalette, h: 20, c: 0.15, radius: '0.25rem', shape: 'sharp', sans: 'Lora', display: 'Lora', mono: 'IBM Plex Mono' }),
  ]
}

function vectors(items: BrandCorpusItem[]): { id: string; name: string; vector: StyleVector }[] {
  return items.map((i) => ({ id: i.id, name: i.name, vector: styleVector(i) }))
}

describe('knnFor', () => {
  it('returns at most k neighbors, excludes self, sorted nearest-first', () => {
    const entries = vectors(toyCorpus())
    const first = entries[0]
    const knn = knnFor(entries, first.id, 8)
    expect(knn).toHaveLength(8)
    expect(knn).not.toContain(first.id)
    const dists = knn.map((id) => styleDistanceOf(entries, first.id, id))
    expect([...dists].sort((a, b) => a - b)).toEqual(dists)
  })

  it('a pastel has pastel nearest neighbors, not terminals', () => {
    const entries = vectors(toyCorpus())
    const pastel = entries.find((e) => e.name === 'pastel a')
    const knn = knnFor(entries, pastel.id, 4)
    const names = knn.map((id) => entries.find((e) => e.id === id)?.name)
    expect(names.slice(0, 2)).toEqual(expect.arrayContaining(['pastel b', 'pastel c']))
    expect(names.slice(2, 4)).toEqual(expect.arrayContaining(['editorial a', 'editorial c']))
    expect(names).not.toContain('terminal a')
  })
})

function styleDistanceOf(entries: { id: string; vector: StyleVector }[], aId: string, bId: string): number {
  const a = entries.find((e) => e.id === aId)
  const b = entries.find((e) => e.id === bId)
  return styleDistance(a.vector, b.vector)
}

describe('clusterCorpus', () => {
  it('groups the toy corpus into the three natural families', () => {
    const items = toyCorpus()
    const clusters = clusterCorpus(vectors(items))
    expect(clusters).toHaveLength(3)
    const memberNames = clusters.map((c) => c.memberIds.map((id) => items.find((i) => i.id === id)?.name).sort())
    expect(memberNames).toContainEqual(['pastel a', 'pastel b', 'pastel c'])
    expect(memberNames).toContainEqual(['terminal a', 'terminal b', 'terminal c'])
    expect(memberNames).toContainEqual(['editorial a', 'editorial b', 'editorial c'])
  })

  it('covers every item exactly once', () => {
    const items = toyCorpus()
    const clusters = clusterCorpus(vectors(items))
    const all = clusters.flatMap((c) => c.memberIds)
    expect(all).toHaveLength(items.length)
    expect(new Set(all).size).toBe(items.length)
  })

  it('dissolves undersized clusters into the nearest surviving cluster', () => {
    // 3+3+3 tight families + 1 far-flung pastel-ish oddball -> oddball joins the pastels
    const oddball = toy('oddball', { palette: pastelPalette, h: 305, c: 0.14, radius: '0.7rem', shape: 'soft', sans: 'Sora', display: 'Sora', mono: 'Geist Mono' })
    const items = [...toyCorpus(), oddball]
    const clusters = clusterCorpus(vectors(items))
    const owning = clusters.find((c) => c.memberIds.includes(oddball.id))
    expect(owning).toBeDefined()
    expect(owning.memberIds.some((id) => items.find((i) => i.id === id)?.name.startsWith('pastel'))).toBe(true)
  })

  it('is deterministic (same input, same output)', () => {
    const items = toyCorpus()
    expect(clusterCorpus(vectors(items))).toEqual(clusterCorpus(vectors(items)))
  })

  it('names clusters after the most-central member', () => {
    const items = toyCorpus()
    const clusters = clusterCorpus(vectors(items))
    for (const c of clusters) {
      expect(c.name).toMatch(/ family$/)
      const centralName = c.name.replace(/ family$/, '')
      expect(c.memberIds.map((id) => items.find((i) => i.id === id)?.name)).toContain(centralName)
    }
  })

  it('emits a centroid vector per cluster with the fixed numeric layout', async () => {
    const { NUMERIC_DIMS } = await import('../style-format/vector')
    const clusters = clusterCorpus(vectors(toyCorpus()))
    for (const c of clusters) {
      expect(c.centroidVector).toHaveLength(NUMERIC_DIMS)
      for (const x of c.centroidVector) {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('adjacentClusterIdsFor (phase-2d M7 tree navigation)', () => {
  function centroidDistance(a: { centroidVector: number[] }, b: { centroidVector: number[] }): number {
    return styleDistance(fromNumericVector(a.centroidVector), fromNumericVector(b.centroidVector))
  }

  it('ranks every other cluster by centroid styleDistance, nearest-first, k=3 cap', () => {
    const clusters = clusterCorpus(vectors(toyCorpus()))
    const adjacency = adjacentClusterIdsFor(clusters)
    expect(clusters).toHaveLength(3)
    for (const cluster of clusters) {
      const adjacent = adjacency[cluster.id]!
      expect(ADJACENT_CLUSTERS_K).toBe(3)
      expect(adjacent.length).toBe(Math.min(ADJACENT_CLUSTERS_K, clusters.length - 1))
      expect(adjacent).not.toContain(cluster.id)
      expect(new Set(adjacent).size).toBe(adjacent.length)
      const distances = adjacent.map((id) => centroidDistance(cluster, clusters.find((c) => c.id === id)!))
      expect([...distances].sort((a, b) => a - b)).toEqual(distances)
    }
  })

  it('bridges the warm families first: pastel ↔ editorial adjacency precedes the terminal family', () => {
    const items = toyCorpus()
    const clusters = clusterCorpus(vectors(items))
    const adjacency = adjacentClusterIdsFor(clusters)
    const familyOf = (clusterId: string): string => {
      const cluster = clusters.find((c) => c.id === clusterId)!
      const firstName = items.find((i) => i.id === cluster.memberIds[0])!.name
      return firstName.split(' ')[0]!
    }
    const clusterOfFamily = (family: string) => clusters.find((c) => familyOf(c.id) === family)!.id
    const pastel = clusterOfFamily('pastel')
    const editorial = clusterOfFamily('editorial')
    const terminal = clusterOfFamily('terminal')
    // The two light warm palettes are mutual nearest neighbors…
    expect(adjacency[pastel]![0]).toBe(editorial)
    expect(adjacency[editorial]![0]).toBe(pastel)
    // …and the dark mono terminal family still lists both warm families as its tunnels.
    expect(adjacency[terminal]!.sort()).toEqual([editorial, pastel].sort())
  })

  it('is deterministic', () => {
    const clusters = clusterCorpus(vectors(toyCorpus()))
    expect(adjacentClusterIdsFor(clusters)).toEqual(adjacentClusterIdsFor(clusterCorpus(vectors(toyCorpus()))))
  })
})
