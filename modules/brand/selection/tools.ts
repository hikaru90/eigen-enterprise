import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import type { ToolDescriptor, ToolContext } from '$lib/kernel/types'
import { brandCorpus, type CorpusRegistry } from '../corpus/runtime'
import { createVisualSetInputSchema, defaultBrandStore, type BrandStore } from '../store'
import { DARK_PIN_PREFIX, applySeedEdit } from '../style-format/reseed'
import {
  buildStyleVectorIndex,
  centroidMatch,
  MAX_SELECTION_PICKS,
  MIN_SELECTION_PICKS,
} from './match'
import { DEFAULT_SIMILAR_LIMIT, similarItems } from './navigate'

/**
 * Kernel tools for the selection wizard surface (phase-2d M4, V7): browse the
 * static corpus as clusters + card summaries, compute the centroid shortlist
 * from the picked style cards, and land the winning design as a draft visual
 * set. Pure math — zero LLM at selection runtime (V10).
 *
 * G8: creating/activating the visual identity is a strategic brand decision —
 * visual_set_create requires a human admin principal. Browsing and matching
 * are pure reads (admin + agent).
 */

export type BrandSelectionToolDeps = {
  store?: BrandStore
  /** Overrides the static corpus (tests inject toy registries). */
  corpus?: CorpusRegistry
}

function requireHuman(ctx: ToolContext): void {
  if (ctx.principal.kind !== 'human') {
    throw new KernelError(
      'permission_denied',
      `brand visual identity mutation requires a human principal (G8); principal ${ctx.principal.id} is ${ctx.principal.kind}`,
    )
  }
}

const corpusGetInput = z.object({ itemId: z.string().uuid() })
const corpusSimilarInput = z.object({
  itemId: z.string().uuid(),
  limit: z.number().int().min(1).max(DEFAULT_SIMILAR_LIMIT).optional(),
})
const selectionMatchesInput = z.object({
  pickedIds: z
    .array(z.string().uuid())
    .min(MIN_SELECTION_PICKS, `the wizard unlocks matches at ${MIN_SELECTION_PICKS} picks`)
    .max(MAX_SELECTION_PICKS, `at most ${MAX_SELECTION_PICKS} picks feed the centroid`),
  limit: z.number().int().min(1).max(MAX_SELECTION_PICKS).optional(),
})
const visualSetGetInput = z.object({ setId: z.string().uuid() })

const visualSetCreateInput = z.object({
  name: z.string().trim().min(1),
  sourceItemId: z.string().uuid().optional(),
  pickedIds: z.array(z.string().uuid()).min(1),
  cssVars: z.record(z.string(), z.string()),
  darkCssVars: z.record(z.string(), z.string()).optional(),
  seeds: z.record(z.string(), z.unknown()).optional(),
})

const visualSetUpdateInput = z.object({
  setId: z.string().uuid(),
  name: z.string().trim().min(1).optional(),
  cssVarsPatch: z.record(z.string(), z.string()).optional(),
  darkCssVarsPatch: z.record(z.string(), z.string()).optional(),
  seedsPatch: z.record(z.string(), z.unknown()).optional(),
  clearPins: z.array(z.string().min(1)).min(1).optional(),
})

export function createBrandSelectionTools(deps: BrandSelectionToolDeps = {}): ToolDescriptor[] {
  const store = deps.store ?? defaultBrandStore()
  const corpus = deps.corpus ?? brandCorpus
  let vectorIndex: ReturnType<typeof buildStyleVectorIndex> | null = null
  const vectorIndexFor = () => (vectorIndex ??= buildStyleVectorIndex(corpus.items))

  const mutationPermission = { roles: ['admin'] }
  const readPermission = { roles: ['admin', 'agent'] }

  return [
    {
      name: 'brand.corpus_list',
      module: 'brand',
      summary:
        'Read the static design corpus as clusters (with M7 adjacency tunnels) + item summaries (id, name, provenance source, cssVars, darkCssVars) — enough to render style cards, no vectors.',
      auditClass: 'read',
      inputSchema: z.object({}),
      permission: readPermission,
      handler: async () => {
        const nameById = new Map(corpus.clusters().map((cluster) => [cluster.id, cluster.name]))
        return {
          builtAt: corpus.index.builtAt,
          itemCount: corpus.index.itemCount,
          clusters: corpus.clusters().map((cluster) => ({
            ...cluster,
            adjacentClusters: cluster.adjacentClusterIds.map((adjacentId) => {
              const name = nameById.get(adjacentId)
              if (name === undefined) {
                throw new Error(`cluster ${cluster.id} tunnels to unknown cluster ${adjacentId}`)
              }
              return { id: adjacentId, name }
            }),
          })),
          items: corpus.items.map((item) => corpus.summary(item)),
        }
      },
    },
    {
      name: 'brand.corpus_get',
      module: 'brand',
      summary: 'Read one full corpus item by id (seeds, cssVars, darkCssVars, provenance).',
      auditClass: 'read',
      inputSchema: corpusGetInput,
      permission: readPermission,
      handler: async (_ctx, input) => corpus.item(corpusGetInput.parse(input).itemId),
    },
    {
      name: 'brand.corpus_similar',
      module: 'brand',
      summary:
        'Tree navigation (M7): ranked "more like this" list for one corpus item, served from the precomputed k-NN in the corpus index — per-neighbor style distance, self excluded, card summaries only. Pure lookup + ranking, zero LLM (V10).',
      auditClass: 'read',
      inputSchema: corpusSimilarInput,
      permission: readPermission,
      handler: async (_ctx, input) => {
        const parsed = corpusSimilarInput.parse(input)
        corpus.item(parsed.itemId)
        const similar = similarItems(corpus.index, corpus.items, parsed.itemId, {
          limit: parsed.limit ?? DEFAULT_SIMILAR_LIMIT,
        })
        return {
          itemId: parsed.itemId,
          similar: similar.map((entry) => ({
            item: corpus.summary(entry.item),
            distance: entry.distance,
          })),
        }
      },
    },
    {
      name: 'brand.selection_matches',
      module: 'brand',
      summary:
        'Compute the weighted centroid of the picked style cards\' vectors (>=3 picks) and return the top-N nearest corpus designs by style distance. Pure math, no LLM (V7/V10).',
      auditClass: 'read',
      inputSchema: selectionMatchesInput,
      permission: readPermission,
      handler: async (_ctx, input) => {
        const parsed = selectionMatchesInput.parse(input)
        const matches = centroidMatch(vectorIndexFor(), corpus.items, parsed.pickedIds, {
          ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
        })
        return {
          matches: matches.map((match) => ({
            item: corpus.summary(match.item),
            distance: match.distance,
          })),
        }
      },
    },
    {
      name: 'brand.visual_set_create',
      module: 'brand',
      summary:
        'Create a draft brand visual set from a wizard selection (name, source corpus item, picked-ids trail, resolved cssVars). Seeds default to the source item\'s seeds. Draft only — activation is the M5 publish gate (G8).',
      auditClass: 'mutate',
      inputSchema: visualSetCreateInput,
      permission: mutationPermission,
      handler: async (ctx, input) => {
        requireHuman(ctx)
        const parsed = visualSetCreateInput.parse(input)
        if (parsed.sourceItemId !== undefined) corpus.item(parsed.sourceItemId)
        const seeds =
          parsed.seeds ??
          (parsed.sourceItemId !== undefined ? corpus.item(parsed.sourceItemId).seeds : null)
        return store.createVisualSet(
          createVisualSetInputSchema.parse({
            name: parsed.name,
            ...(parsed.sourceItemId === undefined ? {} : { sourceItemId: parsed.sourceItemId }),
            pickedItemIds: parsed.pickedIds,
            cssVars: parsed.cssVars,
            ...(parsed.darkCssVars === undefined ? {} : { darkCssVars: parsed.darkCssVars }),
            seeds,
          }),
        )
      },
    },
    {
      name: 'brand.visual_set_activate',
      module: 'brand',
      summary:
        'Activate a draft brand visual set — the approval-gated strategic go-live (V9). Guards: draft-only, cssVars must cover every required role. Activating retires the previously active set in the same operation; its tokens then apply globally to all user-facing surfaces. Requires an explicit approval decision (APPROVAL_REQUIRED_TOOLS).',
      auditClass: 'mutate',
      approvalRisk: 'public',
      inputSchema: visualSetGetInput,
      permission: mutationPermission,
      handler: async (ctx, input) => {
        requireHuman(ctx)
        return store.activateVisualSet(visualSetGetInput.parse(input).setId)
      },
    },
    {
      name: 'brand.visual_set_get',
      module: 'brand',
      summary:
        'Read one brand visual set by id (draft, active, or retired) including its seed block and the owner\'s pins.',
      auditClass: 'read',
      inputSchema: visualSetGetInput,
      permission: readPermission,
      handler: async (_ctx, input) => store.getVisualSet(visualSetGetInput.parse(input).setId),
    },
    {
      name: 'brand.visual_set_list',
      module: 'brand',
      summary: 'List brand visual sets, newest first (working drafts included).',
      auditClass: 'read',
      inputSchema: z.object({}),
      permission: readPermission,
      handler: async () => store.listVisualSets(),
    },
    {
      name: 'brand.visual_set_update',
      module: 'brand',
      summary:
        'Edit a DRAFT visual set (phase-2d M6 visual editor): a seedsPatch re-expands the seed block deterministically (pins beat re-expansion, V3), direct cssVars/darkCssVars patches write resolved values AND pin them, clearPins re-flows values from the expansion. Seedless drafts only accept resolved-value patches. Draft-only (G23); human-only (G8).',
      auditClass: 'mutate',
      inputSchema: visualSetUpdateInput,
      permission: mutationPermission,
      handler: async (ctx, input) => {
        requireHuman(ctx)
        const parsed = visualSetUpdateInput.parse(input)
        const current = await store.getVisualSet(parsed.setId)
        if (!current) throw new Error(`unknown brand visual set: ${parsed.setId}`)

        const wantsExpansion = parsed.seedsPatch !== undefined || parsed.clearPins !== undefined
        let seeds = current.seeds
        let cssVars: Record<string, string> | undefined
        let darkCssVars: Record<string, string> | null | undefined
        let pins = { ...current.pins }

        if (wantsExpansion) {
          if (parsed.clearPins !== undefined) {
            for (const key of parsed.clearPins) {
              if (pins[key] === undefined) {
                throw new Error(`cannot clear unknown pin: ${key} is not pinned on draft ${parsed.setId}`)
              }
              delete pins[key]
            }
          }
          // Re-expansion (applySeedEdit fails loud on seedless drafts): the
          // merged seed block re-flows every non-pinned value from the
          // canonical expansion — pins beat re-expansion (V3).
          const reseeded = applySeedEdit({ seeds, pins }, parsed.seedsPatch ?? {})
          seeds = reseeded.seeds
          cssVars = reseeded.cssVars
          darkCssVars = reseeded.darkCssVars
          pins = reseeded.pins
        }

        // Direct resolved-value edits write AND pin (V3): a pin is how an
        // owner's direct edit survives later seed re-expansions.
        if (parsed.cssVarsPatch !== undefined) {
          cssVars = { ...(cssVars ?? current.cssVars), ...parsed.cssVarsPatch }
          for (const [key, value] of Object.entries(parsed.cssVarsPatch)) pins[key] = value
        }
        if (parsed.darkCssVarsPatch !== undefined) {
          darkCssVars = {
            ...(darkCssVars === undefined || darkCssVars === null
              ? (current.darkCssVars ?? {})
              : darkCssVars),
            ...parsed.darkCssVarsPatch,
          }
          for (const [key, value] of Object.entries(parsed.darkCssVarsPatch)) {
            pins[`${DARK_PIN_PREFIX}${key}`] = value
          }
        }

        return store.updateVisualSet({
          setId: parsed.setId,
          ...(parsed.name === undefined ? {} : { name: parsed.name }),
          ...(cssVars === undefined ? {} : { cssVars }),
          ...(darkCssVars === undefined ? {} : { darkCssVars }),
          ...(seeds === undefined ? {} : { seeds }),
          pins,
        })
      },
    },
  ]
}
