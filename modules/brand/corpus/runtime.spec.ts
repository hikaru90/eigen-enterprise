import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadCorpusItems } from './build'
import { brandCorpus } from './runtime'

const corpusDir = path.join(path.dirname(fileURLToPath(import.meta.url)))

describe('brandCorpus (static module asset registry)', () => {
  it('exposes exactly the on-disk corpus items, all schema-valid', () => {
    const onDisk = loadCorpusItems(corpusDir)
    expect(brandCorpus.items).toHaveLength(onDisk.length)
    expect(brandCorpus.index.itemCount).toBe(onDisk.length)
  })

  it('resolves full items by id and fails loud on unknown ids', () => {
    const first = brandCorpus.items[0]!
    expect(brandCorpus.item(first.id)).toEqual(first)
    expect(() => brandCorpus.item('00000000-0000-4000-8000-000000000000')).toThrow(/unknown corpus item/)
  })

  it('clusters cover every item exactly once (index is not stale)', () => {
    const members = brandCorpus.clusters().flatMap((cluster) => cluster.memberIds)
    expect(members).toHaveLength(brandCorpus.items.length)
    expect(new Set(members).size).toBe(brandCorpus.items.length)
    for (const cluster of brandCorpus.clusters()) {
      expect(cluster.name.length).toBeGreaterThan(0)
    }
  })

  it('M7: every cluster carries bounded, self-free adjacency tunnels to known clusters', () => {
    const ids = new Set(brandCorpus.clusters().map((cluster) => cluster.id))
    for (const cluster of brandCorpus.clusters()) {
      expect(cluster.adjacentClusterIds.length).toBeGreaterThanOrEqual(1)
      expect(cluster.adjacentClusterIds.length).toBeLessThanOrEqual(3)
      expect(cluster.adjacentClusterIds).not.toContain(cluster.id)
      for (const adjacentId of cluster.adjacentClusterIds) {
        expect(ids.has(adjacentId)).toBe(true)
      }
    }
  })

  it('summaries carry card-rendering data but never vectors or seeds', () => {
    const summary = brandCorpus.summary(brandCorpus.items[0]!)
    expect(Object.keys(summary).sort()).toEqual(
      expect.arrayContaining(['cssVars', 'id', 'name', 'provenanceSource']),
    )
    expect(Object.keys(summary).some((key) => key === 'seeds' || key === 'vector')).toBe(false)
    expect(Object.keys(summary.cssVars).length).toBeGreaterThan(0)
  })
})
