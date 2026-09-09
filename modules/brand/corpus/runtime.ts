/// <reference types="vite/client" />
import { validateCorpusItem, type BrandCorpusItem } from '../style-format/corpus'
import corpusIndexJson from './index.json'

/**
 * Runtime view of the static corpus (phase-2d V2): the corpus is an in-repo,
 * git-versioned artifact (items/*.json + index.json), identical for every
 * tenant — imported as module assets so Vite bundles it and no store/kernel
 * component owns corpus files. Everything validates fail-loud at first use:
 * a stale index, duplicate ids, or an invalid item must never reach the
 * selection wizard. Deliberately independent of the dev-time build script
 * (corpus/build.ts) — that one owns fs access and stays out of the runtime
 * module graph.
 */

const itemModules = import.meta.glob<BrandCorpusItem>('./items/*.json', {
  eager: true,
  import: 'default',
})

/** Structural mirror of the build script's CorpusIndex (no runtime dependency on it). */
export type CorpusIndexData = {
  builtAt: string
  itemCount: number
  knn: Record<string, string[]>
  clusters: { id: string; name: string; memberIds: string[]; centroidVector: number[] }[]
}

export type CorpusClusterInfo = { id: string; name: string; memberIds: string[] }

/** Card-rendering summary: no vectors, no seeds (payload stays lean). */
export type CorpusItemSummary = {
  id: string
  name: string
  provenanceSource: BrandCorpusItem['provenance']['source']
  cssVars: Record<string, string>
  darkCssVars?: Record<string, string>
}

export type CorpusRegistry = {
  readonly items: readonly BrandCorpusItem[]
  readonly index: CorpusIndexData
  /** Full item by id; fails loud on unknown ids. */
  item(id: string): BrandCorpusItem
  summary(item: BrandCorpusItem): CorpusItemSummary
  clusters(): CorpusClusterInfo[]
}

function buildRegistry(): CorpusRegistry {
  const items = Object.values(itemModules).map((raw) => validateCorpusItem(raw))
  const byId = new Map(items.map((item) => [item.id, item]))
  if (byId.size !== items.length) {
    throw new Error('duplicate corpus item ids in the static corpus — ingest is not deterministic')
  }

  const index = corpusIndexJson as CorpusIndexData
  if (index.itemCount !== items.length) {
    throw new Error(
      `corpus index is stale: index.itemCount ${index.itemCount} != ${items.length} items — rebuild the corpus index`,
    )
  }
  for (const cluster of index.clusters) {
    for (const memberId of cluster.memberIds) {
      if (!byId.has(memberId)) {
        throw new Error(`corpus index is stale: cluster ${cluster.id} references unknown item ${memberId}`)
      }
    }
  }

  return {
    items,
    index,
    item(id: string): BrandCorpusItem {
      const hit = byId.get(id)
      if (!hit) throw new Error(`unknown corpus item: ${id}`)
      return hit
    },
    summary(item: BrandCorpusItem): CorpusItemSummary {
      const darkCssVars =
        Object.keys(item.darkCssVars).length > 0 ? item.darkCssVars : undefined
      return {
        id: item.id,
        name: item.name,
        provenanceSource: item.provenance.source,
        cssVars: item.cssVars,
        ...(darkCssVars === undefined ? {} : { darkCssVars }),
      }
    },
    clusters(): CorpusClusterInfo[] {
      return index.clusters.map((cluster) => ({
        id: cluster.id,
        name: cluster.name,
        memberIds: [...cluster.memberIds],
      }))
    },
  }
}

export const brandCorpus: CorpusRegistry = buildRegistry()
