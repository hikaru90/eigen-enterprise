import type { BrandCorpusItem } from '../style-format/corpus'
import { fromNumericVector, styleDistance, styleVector } from '../style-format/vector'

/**
 * Tree navigation lookups for the selection wizard (phase-2d M7, V7 — the
 * Every Noise at Once pattern): the similarity structure (per-item k-NN and
 * per-cluster adjacency tunnels) is PRECOMPUTED at build time and committed
 * as corpus/index.json. Runtime is lookups + trivial deterministic ranking
 * only — zero LLM, zero structure computation (V10).
 *
 * Deliberately independent of the dev-time build script (corpus/build.ts):
 * the index is taken structurally, like corpus/runtime.ts does.
 */

export type NavigationCluster = {
  id: string
  name: string
  memberIds: string[]
  centroidVector: number[]
  adjacentClusterIds: string[]
}

export type NavigationIndex = {
  knn: Record<string, string[]>
  clusters: NavigationCluster[]
}

/** Tool-level default result size (the build pins k-NN at k=8). */
export const DEFAULT_SIMILAR_LIMIT = 8

/** A corpus item decorated with its style distance from the pivot item. */
export type SimilarItem = { item: BrandCorpusItem; distance: number }

/** An adjacent cluster with the distance between the two stored centroids. */
export type AdjacentCluster = { id: string; name: string; distance: number }

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`similar items limit must be a positive integer, got: ${limit}`)
  }
}

/**
 * Ranked "more like this" list for one corpus item, following the item's
 * PRECOMPUTED k-NN order from the index (nearest-first, self excluded) and
 * decorating each neighbor with its styleDistance. Throws loud on an unknown
 * item id or a stale knn entry referencing an item that no longer exists.
 */
export function similarItems(
  index: NavigationIndex,
  items: readonly BrandCorpusItem[],
  itemId: string,
  opts: { limit?: number } = {},
): SimilarItem[] {
  if (opts.limit !== undefined) validateLimit(opts.limit)
  const byId = new Map(items.map((item) => [item.id, item]))
  const pivot = byId.get(itemId)
  if (!pivot) throw new Error(`unknown corpus item: ${itemId}`)
  const knn = index.knn[itemId]
  if (!knn) throw new Error(`corpus index is stale: no knn entry for item ${itemId}`)
  const pivotVector = styleVector(pivot)
  const ranked = knn.map((neighborId) => {
    const neighbor = byId.get(neighborId)
    if (!neighbor) {
      throw new Error(`corpus index is stale: knn of item ${itemId} references unknown item ${neighborId}`)
    }
    return { item: neighbor, distance: styleDistance(pivotVector, styleVector(neighbor)) }
  })
  ranked.sort((x, y) => x.distance - y.distance || (x.item.id < y.item.id ? -1 : 1))
  return opts.limit === undefined ? ranked : ranked.slice(0, opts.limit)
}

/**
 * The stored tunnel links of one cluster (up to 3 nearest neighbor clusters,
 * ranked at build time), resolved to names and centroid distances. Throws
 * loud on an unknown cluster id or a stale tunnel reference.
 */
export function adjacentClusters(index: NavigationIndex, clusterId: string): AdjacentCluster[] {
  const cluster = index.clusters.find((c) => c.id === clusterId)
  if (!cluster) throw new Error(`unknown corpus cluster: ${clusterId}`)
  return cluster.adjacentClusterIds.map((adjacentId) => {
    const adjacent = index.clusters.find((c) => c.id === adjacentId)
    if (!adjacent) {
      throw new Error(`corpus index is stale: cluster ${clusterId} tunnels to unknown cluster ${adjacentId}`)
    }
    return {
      id: adjacent.id,
      name: adjacent.name,
      distance: styleDistance(fromNumericVector(cluster.centroidVector), fromNumericVector(adjacent.centroidVector)),
    }
  })
}
