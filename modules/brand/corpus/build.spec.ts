import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { corpusItemSchema, type BrandCorpusItem } from '../style-format/corpus'
import {
  assertIndexInvariants,
  buildCorpus,
  computeIndexContent,
  corpusMinItems,
  expandArchetypes,
  loadCorpusItems,
  type CorpusIndex,
} from './build'

/**
 * The corpus build runs THROUGH vitest on purpose: the pure TS modules
 * (vector/expand/clusters) must be reused with zero toolchain hacks — plain
 * node cannot import them and vite-node is broken for CLI use in this repo.
 * Running this spec regenerates the committed artifacts (archetype item
 * JSONs + index.json) deterministically; content-stable rebuilds leave the
 * worktree untouched.
 */

const corpusDir = path.join(path.dirname(fileURLToPath(import.meta.url)))

function readIndex(): CorpusIndex {
  return JSON.parse(readFileSync(path.join(corpusDir, 'index.json'), 'utf8')) as CorpusIndex
}

describe('corpus build (phase-2d M3)', () => {
  const now = (): Date => new Date('2026-09-09T12:00:00.000Z')
  const stats = buildCorpus(corpusDir, { now })
  const items = loadCorpusItems(corpusDir)
  const index = readIndex()

  it('assembles the corpus from tier-1 ingest + archetypes and writes the index', () => {
    expect(stats.total).toBe(items.length)
    expect(stats.archetypeCount).toBeGreaterThanOrEqual(12)
    expect(stats.total).toBe(items.filter((i) => i.provenance.source === 'tier1').length + stats.archetypeCount)
    expect(existsSync(path.join(corpusDir, 'index.json'))).toBe(true)
  })

  it('validates EVERY item against the corpus schema (fail = build fails)', () => {
    for (const item of items) {
      expect(corpusItemSchema.safeParse(item).success).toBe(true)
    }
  })

  it('satisfies every index invariant: full coverage, k-NN bounds, exactly-one-cluster', () => {
    expect(() => assertIndexInvariants(items, index)).not.toThrow()
  })

  it('M7: every cluster carries bounded, self-free, duplicate-free adjacency tunnels', () => {
    for (const cluster of index.clusters) {
      expect(Array.isArray(cluster.adjacentClusterIds)).toBe(true)
      expect(cluster.adjacentClusterIds.length).toBeGreaterThanOrEqual(1)
      expect(cluster.adjacentClusterIds.length).toBeLessThanOrEqual(3)
      expect(cluster.adjacentClusterIds).not.toContain(cluster.id)
      expect(new Set(cluster.adjacentClusterIds).size).toBe(cluster.adjacentClusterIds.length)
      for (const adjacentId of cluster.adjacentClusterIds) {
        expect(index.clusters.some((c) => c.id === adjacentId)).toBe(true)
      }
    }
  })

  it('M7: adjacency is ranked nearest-first by centroid styleDistance', async () => {
    const { fromNumericVector, styleDistance } = await import('../style-format/vector')
    for (const cluster of index.clusters) {
      const distances = cluster.adjacentClusterIds.map((id) => {
        const other = index.clusters.find((c) => c.id === id)!
        return styleDistance(fromNumericVector(cluster.centroidVector), fromNumericVector(other.centroidVector))
      })
      expect([...distances].sort((a, b) => a - b)).toEqual(distances)
    }
  })

  it('M7: with only 3 clusters the tunnels are exhaustive and exactly symmetric', () => {
    expect(index.clusters.length).toBeLessThanOrEqual(4)
    for (const cluster of index.clusters) {
      expect(cluster.adjacentClusterIds.sort()).toEqual(
        index.clusters.filter((c) => c.id !== cluster.id).map((c) => c.id).sort(),
      )
    }
  })

  it('enforces the minimum corpus size (CORPUS_MIN_OVERRIDE can lower it explicitly)', () => {
    const min = corpusMinItems()
    expect(items.length).toBeGreaterThanOrEqual(min)
  })

  it('has a knn entry with exactly 8 neighbors for every item', () => {
    expect(Object.keys(index.knn)).toHaveLength(items.length)
    for (const neighbors of Object.values(index.knn)) {
      expect(neighbors).toHaveLength(8)
    }
  })

  it('is deterministic: two computed builds are identical except builtAt', () => {
    const a = computeIndexContent(items)
    const b = computeIndexContent(loadCorpusItems(corpusDir))
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    // Read the artifact fresh: what buildCorpus left on disk must equal the
    // computed content byte-for-byte (builtAt excepted).
    const { builtAt: _ignore, ...contentOnDisk } = readIndex()
    expect(JSON.stringify(contentOnDisk)).toBe(JSON.stringify(a))
  })

  it('preserves builtAt and skips writes on content-stable rebuilds', () => {
    const indexBefore = readFileSync(path.join(corpusDir, 'index.json'), 'utf8')
    const rerun = buildCorpus(corpusDir, { now: () => new Date('2030-01-01T00:00:00.000Z') })
    expect(rerun.indexWritten).toBe(false)
    expect(readFileSync(path.join(corpusDir, 'index.json'), 'utf8')).toBe(indexBefore)
  })

  it('rewrites stale archetype expansions from their seed files', () => {
    const itemsDir = path.join(corpusDir, 'items')
    const target = path.join(itemsDir, 'archetype-brutalist.json')
    const original = readFileSync(target, 'utf8')
    try {
      writeFileSync(target, `${original.slice(0, -2)},"corrupted":true}\n`)
      const stale = loadCorpusItems(corpusDir)
      expect(stale.some((i) => 'corrupted' in (i as unknown as Record<string, unknown>))).toBe(false)
      const { written } = expandArchetypes(corpusDir)
      expect(written).toContain('archetype-brutalist.json')
      expect(readFileSync(target, 'utf8')).toBe(original)
    } finally {
      if (readFileSync(target, 'utf8') !== original) writeFileSync(target, original)
    }
  })

  it('keeps every archetype seed file schema-valid and named', () => {
    const { items: archetypes } = expandArchetypes(corpusDir)
    expect(archetypes).toHaveLength(12)
    for (const a of archetypes) {
      expect(a.name.length).toBeGreaterThan(0)
      expect(a.provenance.note?.length ?? 0).toBeGreaterThan(20)
    }
  })

  it('covers the style space across light/dark, sharp/round, serif/mono/sans', () => {
    const vectors = items.map((i) => ({
      dark: (i.darkCssVars['--background'] ?? '').includes('0.1'),
      radius: i.cssVars['--radius'],
      mono: i.seeds.fonts.fontPrimary.includes('Mono'),
      serif: ['Lora', 'Newsreader', 'Fraunces', 'Playfair Display', 'Cormorant Garamond', 'Source Serif 4', 'Libre Baskerville', 'Merriweather'].includes(i.seeds.fonts.fontPrimary),
    }))
    expect(vectors.some((v) => v.dark)).toBe(true)
    expect(vectors.some((v) => v.radius === '0px')).toBe(true)
    expect(vectors.some((v) => v.radius === '999px')).toBe(true)
    expect(vectors.some((v) => v.mono)).toBe(true)
    expect(vectors.some((v) => v.serif)).toBe(true)
  })

  it('never leaves a corpus behind that runtime selection cannot consume', () => {
    const clusters = readIndex().clusters
    expect(clusters.length).toBeGreaterThan(0)
    expect(items.some((i: BrandCorpusItem) => i.provenance.source === 'tier1')).toBe(true)
    expect(items.some((i: BrandCorpusItem) => i.provenance.source === 'archetype')).toBe(true)
  })
})
