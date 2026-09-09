import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { validateCorpusItem, type BrandCorpusItem } from '../style-format/corpus'
import { expandSeeds } from '../style-format/expand'
import { brandSeedsSchema } from '../style-format/seeds'
import { NUMERIC_DIMS, styleVector, type StyleVector } from '../style-format/vector'
import { clusterCorpus, knnFor, KNN_K } from './clusters'
import { BUILD_EPOCH, corpusSlug, deterministicUuid } from './mapping'

/**
 * Corpus build (phase-2d M3). Runs THROUGH vitest (build.spec.ts) so the pure
 * TS modules are reused directly — plain node cannot import this repo's TS
 * modules and vite-node is broken for CLI use here. Zero runtime LLM, zero
 * runtime computation: vectors, k-NN and clusters are all precomputed here and
 * committed as modules/brand/corpus/index.json.
 *
 * builtAt semantics: the timestamp of the last CONTENT-affecting build. When a
 * rebuild produces identical content, the previous builtAt is preserved (and
 * the file is not rewritten) so repeated test runs stay byte-stable in git.
 * Cluster naming is deterministic v0 ("<most-central member name> family");
 * LLM naming is a planned build-time follow-up, not a fallback.
 */

export type CorpusIndex = {
  builtAt: string
  itemCount: number
  knn: Record<string, string[]>
  clusters: { id: string; name: string; memberIds: string[]; centroidVector: number[] }[]
}

/** Wrapper schema for hand-authored archetype seed files (seeds/*.json). */
export const archetypeFileSchema = z.object({
  name: z.string().min(1),
  note: z.string().min(1),
  seeds: brandSeedsSchema,
})

export const CORPUS_MIN_ITEMS = 60

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

/**
 * Expand every archetype seed file and write the resulting corpus item next to
 * the corpus items (items/archetype-<slug>.json) when missing or stale (stale
 * = existing file no longer matches the current deterministic expansion).
 * Expansion errors fail the build — loud.
 */
export function expandArchetypes(corpusDir: string): { items: BrandCorpusItem[]; written: string[] } {
  const seedsDir = path.join(corpusDir, 'seeds')
  const itemsDir = path.join(corpusDir, 'items')
  const files = readdirSync(seedsDir).filter((f) => f.endsWith('.json')).sort()
  if (files.length === 0) {
    throw new Error(`no archetype seed files found in ${seedsDir} — the corpus needs hand-authored archetypes`)
  }

  const items: BrandCorpusItem[] = []
  const written: string[] = []
  for (const file of files) {
    const slug = file.replace(/\.json$/, '')
    const parsed = archetypeFileSchema.parse(readJson(path.join(seedsDir, file)))
    const expanded = expandSeeds(parsed.seeds)
    const item: BrandCorpusItem = {
      id: deterministicUuid(corpusSlug('archetype', slug)),
      name: parsed.name,
      seeds: parsed.seeds,
      cssVars: expanded.cssVars,
      darkCssVars: expanded.darkCssVars,
      provenance: { source: 'archetype', note: parsed.note },
      createdAt: BUILD_EPOCH,
    }
    const target = path.join(itemsDir, `archetype-${slug}.json`)
    const serialized = `${JSON.stringify(item, null, 2)}\n`
    let existing: string | null
    try {
      existing = readFileSync(target, 'utf8')
    } catch {
      existing = null
    }
    if (existing !== serialized) {
      writeFileSync(target, serialized)
      written.push(path.basename(target))
    }
    items.push(item)
  }
  return { items, written }
}

/** Load + validate every items/*.json. All violations are reported in one throw. */
export function loadCorpusItems(corpusDir: string): BrandCorpusItem[] {
  const itemsDir = path.join(corpusDir, 'items')
  const files = readdirSync(itemsDir).filter((f) => f.endsWith('.json')).sort()
  const items: BrandCorpusItem[] = []
  const errors: string[] = []
  for (const file of files) {
    try {
      items.push(validateCorpusItem(readJson(path.join(itemsDir, file))))
    } catch (err) {
      errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (errors.length > 0) {
    throw new Error(`invalid corpus items (${errors.length}):\n${errors.join('\n')}`)
  }
  return items
}

/**
 * Pure index computation over validated items: vectors, k-NN (k=8) and
 * deterministic agglomerative complete-link clusters (threshold 0.35, min
 * cluster size 3 — pinned in clusters.ts).
 */
export function computeIndexContent(items: BrandCorpusItem[]): Omit<CorpusIndex, 'builtAt'> {
  const ids = new Set(items.map((i) => i.id))
  if (ids.size !== items.length) throw new Error('duplicate corpus item ids — ingest is not deterministic')

  const entries = items.map((item) => ({ id: item.id, name: item.name, vector: styleVector(item) }))
  const knn: Record<string, string[]> = {}
  for (const entry of entries) {
    knn[entry.id] = knnFor(entries, entry.id, KNN_K)
  }
  const clusters = clusterCorpus(entries)
  return { itemCount: items.length, knn, clusters }
}

/** CORPUS_MIN_OVERRIDE lets the owner lower (or zero) the size bar explicitly. */
export function corpusMinItems(): number {
  const override = process.env.CORPUS_MIN_OVERRIDE
  if (override === undefined) return CORPUS_MIN_ITEMS
  const parsed = Number.parseInt(override, 10)
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`CORPUS_MIN_OVERRIDE must be a non-negative integer, got: "${override}"`)
  }
  return parsed
}

/**
 * Full corpus build: expand archetypes, load + validate items, compute index,
 * write index.json (preserving builtAt on content-stable rebuilds).
 * Returns build stats. Fails loud on any invalid item or size shortfall.
 */
export function buildCorpus(corpusDir: string, opts: { now: () => Date }): { total: number; archetypeCount: number; tier1Count: number; indexWritten: boolean } {
  const expanded = expandArchetypes(corpusDir)
  const items = loadCorpusItems(corpusDir)

  const minItems = corpusMinItems()
  if (items.length < minItems) {
    throw new Error(`corpus too small: ${items.length} items < required ${minItems} (set CORPUS_MIN_OVERRIDE to lower the bar explicitly — never silently)`)
  }

  const content = computeIndexContent(items)
  const target = path.join(corpusDir, 'index.json')
  const next: CorpusIndex = { builtAt: opts.now().toISOString(), ...content }
  let indexWritten = true
  try {
    const existingParsed = JSON.parse(readFileSync(target, 'utf8')) as CorpusIndex
    const { builtAt: _old, ...oldContent } = existingParsed
    const { builtAt: _new, ...newContent } = next
    if (JSON.stringify(oldContent) === JSON.stringify(newContent)) {
      // Content-stable rebuild: keep the existing builtAt, skip the write so
      // repeated test runs never dirty the worktree.
      indexWritten = false
    } else {
      writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`)
    }
  } catch {
    writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`)
  }

  const tier1Count = items.length - expanded.items.length
  return { total: items.length, archetypeCount: expanded.items.length, tier1Count, indexWritten }
}

/**
 * Assert every build invariant. Throws with the full violation list —
 * a corpus that fails any invariant must never reach runtime selection.
 */
export function assertIndexInvariants(items: BrandCorpusItem[], index: CorpusIndex, minItems: number = corpusMinItems()): void {
  const violations: string[] = []
  const ids = items.map((i) => i.id)

  if (minItems > 0 && items.length < minItems) {
    violations.push(`item count ${items.length} < ${minItems}`)
  }
  if (index.itemCount !== items.length) {
    violations.push(`index.itemCount ${index.itemCount} != loaded items ${items.length}`)
  }
  const idSet = new Set(ids)
  for (const [id, neighbors] of Object.entries(index.knn)) {
    if (!idSet.has(id)) violations.push(`knn has unknown id ${id}`)
    if (neighbors.length > 8) violations.push(`knn[${id}] has ${neighbors.length} entries (max 8)`)
    if (neighbors.includes(id)) violations.push(`knn[${id}] includes self`)
    for (const n of neighbors) {
      if (!idSet.has(n)) violations.push(`knn[${id}] references unknown id ${n}`)
    }
  }
  for (const id of ids) {
    if (!(id in index.knn)) violations.push(`item ${id} missing from knn`)
  }
  const seen = new Map<string, string>()
  for (const cluster of index.clusters) {
    for (const memberId of cluster.memberIds) {
      if (!idSet.has(memberId)) violations.push(`cluster ${cluster.id} references unknown id ${memberId}`)
      if (seen.has(memberId)) violations.push(`item ${memberId} in clusters ${seen.get(memberId)} and ${cluster.id}`)
      seen.set(memberId, cluster.id)
    }
    if (cluster.centroidVector.length !== NUMERIC_DIMS) {
      violations.push(`cluster ${cluster.id} centroid has ${cluster.centroidVector.length} dims (expected ${NUMERIC_DIMS})`)
    }
  }
  for (const id of ids) {
    if (!seen.has(id)) violations.push(`item ${id} is in no cluster`)
  }
  if (violations.length > 0) {
    throw new Error(`corpus index invariant violations (${violations.length}):\n${violations.join('\n')}`)
  }
}

export type { StyleVector }
