import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import type { ToolDescriptor, ToolContext } from '$lib/kernel/types'
import { createBrandExtractTools, type BrandExtractToolDeps } from './extract/tools'
import { createBrandSelectionTools, type BrandSelectionToolDeps } from './selection/tools'
import {
  createSetInputSchema,
  defaultBrandStore,
  updateSetInputSchema,
  type BrandStore,
} from './store'

/**
 * Kernel tool descriptors over the BrandStore (phase-2c M2: guideline
 * curation surface), the phase-2d extraction judge loop, and the phase-2d M4
 * selection wizard. Stores are injected (tests pass in-memory stores;
 * production resolves the DB lazily per operation).
 *
 * G8/D5: guideline mutations are human-admin-only — descriptor roles are
 * ['admin'] AND the handler rejects non-human principals (agents get
 * permission_denied, loud). brand.set_activate is additionally approval-gated
 * via APPROVAL_REQUIRED_TOOLS (modules/index.ts).
 */

export type BrandToolDeps = {
  store?: BrandStore
  /** Deps for the phase-2d extraction tools (store/capture/propose seams). */
  extract?: BrandExtractToolDeps
  /** Deps for the phase-2d M4 selection wizard tools (store/corpus seams). */
  selection?: BrandSelectionToolDeps
}

/** G8: strategic brand decisions are human-owned; agents never self-author boundaries (G19). */
function requireHuman(ctx: ToolContext): void {
  if (ctx.principal.kind !== 'human') {
    throw new KernelError(
      'permission_denied',
      `brand guideline mutation requires a human principal (G8); principal ${ctx.principal.id} is ${ctx.principal.kind}`,
    )
  }
}

const setIdInput = z.object({ setId: z.string().uuid() })

const listSetsInput = z.object({
  status: z.enum(['draft', 'active', 'retired']).optional(),
  locale: z.string().min(1).optional(),
})

const exampleAddInput = z.object({
  setId: z.string().uuid(),
  contentType: z.string().min(1),
  situation: z.string().min(1).optional(),
  body: z.string().min(1),
  label: z.enum(['good', 'bad']),
  rationale: z.string().min(1).optional(),
})

const lexiconAddInput = z.object({
  setId: z.string().uuid(),
  term: z.string().min(1),
  kind: z.enum(['allowed', 'banned', 'required']),
  contextKey: z.string().min(1).optional(),
  replacement: z.string().min(1).optional(),
})

const criterionAddInput = z.object({
  setId: z.string().uuid(),
  contentType: z.string().min(1),
  criterion: z.string().min(1),
  kind: z.enum(['deterministic', 'judge']),
  spec: z.record(z.string(), z.unknown()),
  riskTier: z.enum(['low', 'standard', 'heritage']).default('standard'),
})

const tokenAddInput = z.object({
  setId: z.string().uuid(),
  token: z.string().min(1),
  value: z.string().min(1),
  proseRationale: z.string().min(1).optional(),
  styleVocabulary: z.array(z.string().min(1)).default([]),
})

const glossaryAddInput = z.object({
  setId: z.string().uuid(),
  term: z.string().min(1),
  definition: z.string().min(1),
  usageNote: z.string().min(1).optional(),
})

/** Kernel descriptors for the brand guideline curation surface. */
export function createBrandTools(deps: BrandToolDeps = {}): ToolDescriptor[] {
  const store = deps.store ?? defaultBrandStore()
  // Plain string[] (not as const): ToolDescriptor.permission.roles is string[].
  const mutationPermission = { roles: ['admin'] }
  const readPermission = { roles: ['admin', 'agent'] }

  return [
    ...createBrandExtractTools(deps.extract ?? {}),
    ...createBrandSelectionTools({ store, ...(deps.selection ?? {}) }),
    {
      name: 'brand.set_create',
      module: 'brand',
      summary:
        'Create a draft brand guideline set (locale + CARE context incl. multi-word tone attributes). Versions increment per locale.',
      auditClass: 'mutate',
      inputSchema: createSetInputSchema,
      permission: mutationPermission,
      handler: async (ctx, input) => {
        requireHuman(ctx)
        return store.createSet(createSetInputSchema.parse(input))
      },
    },
    {
      name: 'brand.set_update',
      module: 'brand',
      summary:
        'Patch the context of a draft guideline set. Active/retired sets are immutable (G23) — fail loud.',
      auditClass: 'mutate',
      inputSchema: updateSetInputSchema,
      permission: mutationPermission,
      handler: async (ctx, input) => {
        requireHuman(ctx)
        return store.updateDraftSet(updateSetInputSchema.parse(input))
      },
    },
    {
      name: 'brand.set_activate',
      module: 'brand',
      summary:
        'Activate a draft guideline set (one active per locale). Guards: CARE-complete context, >=2 voice examples incl. >=1 good and >=1 bad (G2). Approval-gated.',
      auditClass: 'mutate',
      inputSchema: setIdInput,
      permission: mutationPermission,
      handler: async (ctx, input) => {
        requireHuman(ctx)
        return store.activateSet(setIdInput.parse(input).setId)
      },
    },
    {
      name: 'brand.set_get',
      module: 'brand',
      summary: 'Read one guideline set by id.',
      auditClass: 'read',
      inputSchema: setIdInput,
      permission: readPermission,
      handler: async (_ctx, input) => store.getSet(setIdInput.parse(input).setId),
    },
    {
      name: 'brand.set_list',
      module: 'brand',
      summary: 'List guideline sets, optionally filtered by status and/or locale.',
      auditClass: 'read',
      inputSchema: listSetsInput,
      permission: readPermission,
      handler: async (_ctx, input) => {
        const parsed = listSetsInput.parse(input)
        return store.listSets({
          ...(parsed.status === undefined ? {} : { status: parsed.status }),
          ...(parsed.locale === undefined ? {} : { locale: parsed.locale }),
        })
      },
    },
    {
      name: 'brand.example_add',
      module: 'brand',
      summary:
        'Add a voice exemplar (good|bad) to a draft set — the primary voice representation (G2).',
      auditClass: 'mutate',
      inputSchema: exampleAddInput,
      permission: mutationPermission,
      handler: async (ctx, input) => {
        requireHuman(ctx)
        return store.addVoiceExample(exampleAddInput.parse(input))
      },
    },
    {
      name: 'brand.lexicon_add',
      module: 'brand',
      summary:
        'Add an allowed|banned|required term to a draft set. Banned/required terms feed the deterministic validation layer (G11).',
      auditClass: 'mutate',
      inputSchema: lexiconAddInput,
      permission: mutationPermission,
      handler: async (ctx, input) => {
        requireHuman(ctx)
        return store.addLexiconEntry(lexiconAddInput.parse(input))
      },
    },
    {
      name: 'brand.criterion_add',
      module: 'brand',
      summary:
        'Add a validation criterion for a content type (deterministic spec or judge spec) with risk tier (G10/G16).',
      auditClass: 'mutate',
      inputSchema: criterionAddInput,
      permission: mutationPermission,
      handler: async (ctx, input) => {
        requireHuman(ctx)
        return store.addCriterion(criterionAddInput.parse(input))
      },
    },
    {
      name: 'brand.token_add',
      module: 'brand',
      summary:
        'Add a named visual token (value + prose rationale + style vocabulary) to a draft set (G5; owlery bootstraps the store later, D1).',
      auditClass: 'mutate',
      inputSchema: tokenAddInput,
      permission: mutationPermission,
      handler: async (ctx, input) => {
        requireHuman(ctx)
        return store.addVisualToken(tokenAddInput.parse(input))
      },
    },
    {
      name: 'brand.glossary_add',
      module: 'brand',
      summary: 'Add a glossary term + definition to a draft set.',
      auditClass: 'mutate',
      inputSchema: glossaryAddInput,
      permission: mutationPermission,
      handler: async (ctx, input) => {
        requireHuman(ctx)
        return store.addGlossaryEntry(glossaryAddInput.parse(input))
      },
    },
  ]
}
