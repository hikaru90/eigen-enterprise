import type { SiblingGroup } from '../distinct'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { validateCorpusItem, type BrandCorpusItem } from '../../style-format/corpus'
import { styleVector, type StyleVector } from '../../style-format/vector'
import { pickerIndexSchema, pickerShapeSchema, type PickerIndex, type PickerNode } from '../picker-index'
import {
  colorsFromCorpusVars,
  compactFromSet,
  deriveDarkPalette,
  DENSITY_STEP,
  expandPalette,
  fontStack,
  RADIUS_VALUE,
  repairContrast,
  type ColorRole,
  type CompactPalette,
  type Mode,
  type Repair,
} from './derive'

/**
 * Builds `modules/brand/taxonomy/styles.json` (brand picker B2a) from the
 * hand-edited `authoring/palettes.json` plus corpus items. Pure and
 * deterministic: same inputs → byte-identical output. Runs through vitest
 * (build-styles.spec.ts), like the corpus build — plain node cannot import the
 * repo's extensionless TS modules.
 */

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const colour = z.string().min(1)
const compactSchema = z
  .object({ bg: colour, fg: colour, primary: colour, accent: colour, secondary: colour.optional() })
  .strict()

const authoredNodeBase = {
  id: slug,
  name: z.string().min(1),
  description: z.string().min(1),
  fonts: z.object({ heading: z.string().min(1), body: z.string().min(1), mono: z.string().min(1) }).strict(),
  shape: pickerShapeSchema.strict(),
  light: compactSchema.optional(),
  dark: compactSchema.optional(),
  /** Reuse a corpus item's token set per theme (dark: the item's darkCssVars, or cssVars of a dark-only theme). */
  corpus: z.object({ light: slug.optional(), dark: slug.optional() }).strict().optional(),
  /** Provenance of a variant re-aimed from a former dark-mode variant (owner decision 2026-11-02). */
  reaimedFrom: slug.optional(),
}
const authoredVariantSchema = z.object(authoredNodeBase).strict()
const authoredStyleSchema = z.object({ ...authoredNodeBase, variants: z.array(authoredVariantSchema).min(2) }).strict()
const authoredGenreSchema = z.object({ ...authoredNodeBase, styles: z.array(authoredStyleSchema).min(2) }).strict()
export const authoredPalettesSchema = z
  .object({ version: z.literal(1), note: z.string().min(1), genres: z.array(authoredGenreSchema).min(2) })
  .strict()
export type AuthoredPalettes = z.infer<typeof authoredPalettesSchema>
type AuthoredNode = z.infer<typeof authoredVariantSchema>

export type CorpusRepair = { nodeId: string; mode: Mode; slug: string } & Repair

export type BuildResult = { index: PickerIndex; corpusRepairs: CorpusRepair[] }

function loadItem(corpusDir: string, s: string): BrandCorpusItem {
  return validateCorpusItem(JSON.parse(readFileSync(path.join(corpusDir, 'items', `${s}.json`), 'utf8')))
}

/**
 * Resolve one node's token sets. Per theme the precedence is explicit:
 * corpus slug → authored compact palette → (dark only) derived from the light
 * compact palette (authored, or read back from the corpus light set).
 */
function resolveNode(
  n: AuthoredNode,
  level: PickerNode['level'],
  parentId: string | null,
  corpus: (s: string) => BrandCorpusItem,
  repairs: CorpusRepair[],
): PickerNode {
  const colors: Partial<Record<Mode, Record<ColorRole, string>>> = {}
  const fromCorpus = (mode: Mode, s: string) => {
    const item = corpus(s)
    const vars = mode === 'dark' && Object.keys(item.darkCssVars).length > 0 ? item.darkCssVars : item.cssVars
    const what = `${n.id} (${s}, ${mode})`
    let resolved: ReturnType<typeof repairContrast>
    try {
      resolved = repairContrast(
        colorsFromCorpusVars(vars, mode, what, (rep) => repairs.push({ nodeId: n.id, mode, slug: s, ...rep })),
      )
    } catch (err) {
      throw new Error(`${what}: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    }
    const { set, repairs: r } = resolved
    for (const rep of r) repairs.push({ nodeId: n.id, mode, slug: s, ...rep })
    return set
  }
  if (n.corpus?.light && n.light) throw new Error(`${n.id}: light theme given both as corpus and authored palette`)
  if (n.corpus?.dark && n.dark) throw new Error(`${n.id}: dark theme given both as corpus and authored palette`)
  if (n.corpus?.light) colors.light = fromCorpus('light', n.corpus.light)
  else if (n.light) colors.light = expandPalette(n.light, 'light')
  else throw new Error(`${n.id}: no light theme (corpus.light or light palette)`)
  if (n.corpus?.dark) colors.dark = fromCorpus('dark', n.corpus.dark)
  else {
    const lightCompact: CompactPalette = n.light ?? compactFromSet(colors.light)
    colors.dark = expandPalette(n.dark ?? deriveDarkPalette(lightCompact), 'dark')
  }
  const extras = {
    radius: RADIUS_VALUE[n.shape.radius],
    'font-display': fontStack(n.fonts.heading),
    'font-sans': fontStack(n.fonts.body),
    'font-mono': fontStack(n.fonts.mono),
  }
  const slugs = [...new Set([n.corpus?.light, n.corpus?.dark].filter((s): s is string => typeof s === 'string'))]
  return {
    id: n.id,
    level,
    parentId,
    name: n.name,
    description: n.description,
    fonts: n.fonts,
    shape: n.shape,
    tokens: { light: { ...colors.light, ...extras }, dark: { ...colors.dark!, ...extras } },
    source: slugs.length > 0 ? { kind: 'corpus', slugs } : { kind: 'authored' },
  }
}

export function buildStyles(authored: AuthoredPalettes, corpusDir: string): BuildResult {
  const cache = new Map<string, BrandCorpusItem>()
  const corpus = (s: string) => {
    if (!cache.has(s)) cache.set(s, loadItem(corpusDir, s))
    return cache.get(s)!
  }
  const repairs: CorpusRepair[] = []
  const nodes: PickerNode[] = []
  for (const g of authored.genres) {
    nodes.push(resolveNode(g, 'genre', null, corpus, repairs))
    for (const s of g.styles) {
      nodes.push(resolveNode(s, 'style', g.id, corpus, repairs))
      for (const v of s.variants) nodes.push(resolveNode(v, 'variant', s.id, corpus, repairs))
    }
  }
  return { index: pickerIndexSchema.parse({ version: 1, nodes }), corpusRepairs: repairs }
}

export function parseAuthoredPalettes(raw: unknown): AuthoredPalettes {
  const r = authoredPalettesSchema.safeParse(raw)
  if (!r.success) {
    throw new Error(`invalid authored palettes: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  }
  return r.data
}

/** Canonical file bytes: 2-space JSON + trailing newline. */
export function serializeStyles(index: PickerIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`
}

const ELEVATION = { flat: 'flat', subtle: 'subtle', layered: 'layered' } as const

/**
 * Style vector of a picker node: the corpus-item vector math applied to the
 * node's own light/dark token sets. Spacing comes from the node's density,
 * elevation from its shape, grain is 0 (no picker node carries grain).
 */
export function nodeStyleVector(node: PickerNode): StyleVector {
  const prefix = (set: Record<string, string>) => Object.fromEntries(Object.entries(set).map(([k, v]) => [`--${k}`, v]))
  const pseudo = {
    name: node.id,
    cssVars: prefix(node.tokens.light),
    darkCssVars: prefix(node.tokens.dark),
    seeds: {
      grain: 0,
      elevation: ELEVATION[node.shape.elevation],
      fluidScale: { baseSize: { min: 16 } },
      spaceRhythm: [DENSITY_STEP[node.shape.density]],
    },
  }
  // styleVector reads only the fields above; the remaining corpus-item fields are irrelevant to the metric.
  return styleVector(pseudo as unknown as BrandCorpusItem)
}

/** Sibling groups over picker nodes: root (genres), each genre (styles), each style (variants). */
export function siblingGroupsOfNodes(nodes: PickerNode[]): SiblingGroup[] {
  const groups = new Map<string, SiblingGroup>()
  for (const n of nodes) {
    const parentId = n.parentId ?? 'root'
    if (!groups.has(parentId)) groups.set(parentId, { parentId, children: [] })
    groups.get(parentId)!.children.push({ id: n.id, vector: nodeStyleVector(n) })
  }
  return [...groups.values()]
}
