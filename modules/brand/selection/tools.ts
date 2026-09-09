import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import type { ToolDescriptor, ToolContext } from '$lib/kernel/types'
import { brandCorpus, type CorpusRegistry } from '../corpus/runtime'
import { createVisualSetInputSchema, defaultBrandStore, type BrandStore } from '../store'
import {
  buildStyleVectorIndex,
  centroidMatch,
  MAX_SELECTION_PICKS,
  MIN_SELECTION_PICKS,
} from './match'

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
        'Read the static design corpus as clusters + item summaries (id, name, provenance source, cssVars, darkCssVars) — enough to render style cards, no vectors.',
      auditClass: 'read',
      inputSchema: z.object({}),
      permission: readPermission,
      handler: async () => ({
        builtAt: corpus.index.builtAt,
        itemCount: corpus.index.itemCount,
        clusters: corpus.clusters(),
        items: corpus.items.map((item) => corpus.summary(item)),
      }),
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
      summary: 'Read one brand visual set by id (draft, active, or retired).',
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
  ]
}
