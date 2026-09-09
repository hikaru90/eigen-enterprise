import { fromNumericVector, styleDistance, toNumericVector, type StyleVector } from '../style-format/vector'

/**
 * Build-time similarity structures over the corpus (phase-2d M3): k-NN and
 * deterministic agglomerative complete-link clustering. Pure functions over
 * {id, name, vector} entries — no RNG, no env; every tie-break is pinned so
 * repeated builds are byte-identical.
 */

export const KNN_K = 8
/** Complete-link merge threshold in style distance (0..1). */
export const CLUSTER_THRESHOLD = 0.35
/** Clusters below this size dissolve; members join their nearest survivor. */
export const CLUSTER_MIN_SIZE = 3
/** Tunnel links per cluster for tree navigation (phase-2d M7, V7). */
export const ADJACENT_CLUSTERS_K = 3

export type VectorEntry = { id: string; name: string; vector: StyleVector }

export type CorpusCluster = {
  /** Deterministic id: `cluster-<n>` after sorting clusters by smallest member id. */
  id: string
  /** v0 naming: "<most-central member name> family" (LLM naming is a logged follow-up). */
  name: string
  memberIds: string[]
  /** Mean of member vectors in the fixed 48-dim numeric layout. */
  centroidVector: number[]
}

/** k nearest neighbors of `id`, nearest-first, self excluded, ties by id. */
export function knnFor(entries: VectorEntry[], id: string, k: number = KNN_K): string[] {
  const self = entries.find((e) => e.id === id)
  if (!self) throw new Error(`knnFor: unknown id ${id}`)
  return entries
    .filter((e) => e.id !== id)
    .map((e) => ({ id: e.id, dist: styleDistance(self.vector, e.vector) }))
    .sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1))
    .slice(0, k)
    .map((e) => e.id)
}

type Group = number[] // indices into entries

/**
 * Precomputed symmetric pairwise distance matrix (row-major upper triangle in
 * a flat array) — one styleDistance call per pair, everything else is lookup.
 */
function distanceMatrix(entries: VectorEntry[]): { dist: (i: number, j: number) => number } {
  const n = entries.length
  const flat = new Float64Array((n * (n + 1)) / 2)
  const idx = (i: number, j: number) => (i > j ? i * (i + 1) / 2 + j : j * (j + 1) / 2 + i)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      flat[idx(i, j)] = styleDistance(entries[i].vector, entries[j].vector)
    }
  }
  return {
    dist: (i, j) => (i === j ? 0 : flat[idx(i, j)]),
  }
}

function completeLink(dist: (i: number, j: number) => number, a: Group, b: Group): number {
  let max = 0
  for (const i of a) {
    for (const j of b) {
      const d = dist(i, j)
      if (d > max) max = d
    }
  }
  return max
}

/** Stable total order for cluster pairs: distance, then smallest member ids. */
function pairLess(dist: (i: number, j: number) => number, entries: VectorEntry[], a: Group, b: Group, c: Group, d: Group): boolean {
  const dab = completeLink(dist, a, b)
  const dcd = completeLink(dist, c, d)
  if (dab !== dcd) return dab < dcd
  const min = (g: Group) => Math.min(...g)
  const keyAB = [entries[min(a)].id, entries[min(b)].id]
  const keyCD = [entries[min(c)].id, entries[min(d)].id]
  return keyAB.join('|') < keyCD.join('|')
}

/**
 * Agglomerative complete-link clustering with pinned behavior:
 *  1. merge the globally closest cluster pair while complete-link distance ≤ CLUSTER_THRESHOLD
 *     (ties broken by smallest member ids),
 *  2. dissolve clusters smaller than CLUSTER_MIN_SIZE; each dissolves (ascending by
 *     smallest member id) into the nearest surviving cluster (ties by smallest member id),
 *  3. degenerate case — if nothing survives step 1, all clusters are kept as-is so
 *     every item still lands in exactly one cluster,
 *  4. clusters sort by smallest member id; ids are `cluster-<n>` (1-based).
 */
export function clusterCorpus(entries: VectorEntry[]): CorpusCluster[] {
  if (entries.length === 0) return []
  const { dist } = distanceMatrix(entries)
  const groups: Group[] = entries.map((_, i) => [i])

  while (groups.length > 1) {
    let bestA = -1
    let bestB = -1
    for (let a = 0; a < groups.length; a++) {
      for (let b = a + 1; b < groups.length; b++) {
        if (bestA === -1 || pairLess(dist, entries, groups[a], groups[b], groups[bestA], groups[bestB])) {
          bestA = a
          bestB = b
        }
      }
    }
    if (completeLink(dist, groups[bestA], groups[bestB]) > CLUSTER_THRESHOLD) break
    const merged = [...groups[bestA], ...groups[bestB]].sort((x, y) => x - y)
    groups.splice(bestB, 1)
    groups.splice(bestA, 1)
    groups.push(merged)
  }

  const survivors = groups.filter((g) => g.length >= CLUSTER_MIN_SIZE)
  const undersized = groups
    .filter((g) => g.length < CLUSTER_MIN_SIZE)
    .sort((a, b) => (entries[Math.min(...a)].id < entries[Math.min(...b)].id ? -1 : 1))

  if (survivors.length > 0) {
    for (const small of undersized) {
      let target = -1
      for (let s = 0; s < survivors.length; s++) {
        if (target === -1 || pairLess(dist, entries, small, survivors[s], small, survivors[target])) target = s
      }
      survivors[target] = [...survivors[target], ...small].sort((x, y) => x - y)
    }
    survivors.sort((a, b) => (entries[Math.min(...a)].id < entries[Math.min(...b)].id ? -1 : 1))
    return survivors.map((members, idx) => finalizeCluster(entries, members, `cluster-${idx + 1}`))
  }
  groups.sort((a, b) => (entries[Math.min(...a)].id < entries[Math.min(...b)].id ? -1 : 1))
  return groups.map((members, idx) => finalizeCluster(entries, members, `cluster-${idx + 1}`))
}

function finalizeCluster(entries: VectorEntry[], members: Group, id: string): CorpusCluster {
  const memberIds = members.map((i) => entries[i].id)
  const { dist } = distanceMatrix(members.map((i) => entries[i]))
  // Most central member: lowest mean distance to the rest; ties by id.
  let central = 0
  let centralMean = Number.POSITIVE_INFINITY
  for (let i = 0; i < members.length; i++) {
    const mean = members.length === 1 ? 0 : members.reduce((s, _j, j) => (j === i ? s : s + dist(i, j)), 0) / (members.length - 1)
    if (mean < centralMean || (mean === centralMean && entries[members[i]].id < entries[members[central]].id)) {
      central = i
      centralMean = mean
    }
  }
  const centroidVector = toNumericVector(entries[members[0]].vector).map((_, dim) => {
    const sum = members.reduce((s, i) => s + toNumericVector(entries[i].vector)[dim], 0)
    return Math.round((sum / members.length) * 1e6) / 1e6
  })
  return { id, name: `${entries[members[central]].name} family`, memberIds, centroidVector }
}

export type CentroidEntry = { id: string; centroidVector: number[] }

/**
 * Cluster adjacency for tree navigation (phase-2d M7): every cluster lists up
 * to ADJACENT_CLUSTERS_K other clusters, ranked by styleDistance over the
 * STORED centroid vectors (fromNumericVector reconstruction — the exact same
 * metric as item-level k-NN). Deterministic: distance, then cluster id.
 * Tunnels may be asymmetric when more than ADJACENT_CLUSTERS_K + 1 clusters
 * exist (A's top-3 can include B while B's does not include A) — documented
 * V7 semantics, invariants assert exact symmetry only where the cluster count
 * makes the lists exhaustive.
 */
export function adjacentClusterIdsFor(clusters: readonly CentroidEntry[], k: number = ADJACENT_CLUSTERS_K): Record<string, string[]> {
  const byId = new Map(clusters.map((c) => [c.id, c]))
  if (byId.size !== clusters.length) throw new Error('adjacentClusterIdsFor: duplicate cluster ids')
  const adjacency: Record<string, string[]> = {}
  for (const cluster of clusters) {
    if (!Number.isInteger(k) || k < 1) throw new Error(`adjacentClusterIdsFor: k must be a positive integer, got ${k}`)
    adjacency[cluster.id] = clusters
      .filter((other) => other.id !== cluster.id)
      .map((other) => ({
        id: other.id,
        dist: styleDistance(fromNumericVector(cluster.centroidVector), fromNumericVector(other.centroidVector)),
      }))
      .sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1))
      .slice(0, k)
      .map((e) => e.id)
  }
  return adjacency
}
