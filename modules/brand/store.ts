import { and, desc, eq, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { DbHandle } from '$lib/kernel/db-stores'
import {
  brandCriteria,
  brandGlossary,
  brandGuidelineSets,
  brandLexicon,
  brandVisualSets,
  brandVisualTokens,
  brandVoiceExamples,
  type BrandGuidelineSetContext,
} from '$lib/server/db/brand.schema'
import { brandSeedsSchema, type BrandSeeds } from './style-format/seeds'

/**
 * BrandStore — the company's brand as executable context (phase-2c, M2).
 * Ruleset of record: plan/branding-module-rules.md. The store owns the
 * guideline-set lifecycle guards so every caller (kernel tools now, gateway
 * middleware later) inherits them:
 *   - sets are immutable once active/retired (G23 versioning);
 *   - activation requires exemplar-first voice (G2), a multi-word tone set,
 *     CARE-complete context, and one active set per locale (D3);
 *   - child curation tables are writable only while the set is a draft.
 */

export type BrandSetStatus = 'draft' | 'active' | 'retired'
export type BrandRiskTier = 'low' | 'standard' | 'heritage'

export type BrandGuidelineSet = {
  id: string
  version: number
  locale: string
  status: BrandSetStatus
  context: BrandGuidelineSetContext
  baseSetId: string | null
  activatedAt: string | null
  validationRunId: string | null
  eventId: string | null
  createdAt: string
}

export type BrandVoiceExample = {
  id: string
  setId: string
  contentType: string
  situation: string | null
  body: string
  label: 'good' | 'bad'
  rationale: string | null
}

export type BrandLexiconEntry = {
  id: string
  setId: string
  term: string
  kind: 'allowed' | 'banned' | 'required'
  contextKey: string | null
  replacement: string | null
}

export type BrandCriterion = {
  id: string
  setId: string
  contentType: string
  criterion: string
  kind: 'deterministic' | 'judge'
  spec: Record<string, unknown>
  riskTier: BrandRiskTier
}

export type BrandVisualToken = {
  id: string
  setId: string
  token: string
  value: string
  proseRationale: string | null
  styleVocabulary: string[]
}

export type BrandGlossaryEntry = {
  id: string
  setId: string
  term: string
  definition: string
  usageNote: string | null
}

// ---------------------------------------------------------------------------
// Shared zod schemas (consumed by modules/brand/tools.ts as descriptor inputs).
// Locale checks are syntax-only; brand semantics are never string heuristics (G14).
// ---------------------------------------------------------------------------

/** BCP-47 shape check (syntax only, D3). */
export const brandLocaleSchema = z
  .string()
  .regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]+)*$/, 'locale must be a BCP-47 tag (e.g. en, en-US)')

/** G2: tone descriptors are multi-word nuanced sets; a single tone word is rejected here, at schema level. */
export const toneAttributesSchema = z
  .array(
    z
      .string()
      .trim()
      .refine((v) => v.split(/\s+/).length >= 2, {
        message:
          'each tone attribute must be a multi-word nuanced set (G2) — single tone words exaggerate',
      }),
  )
  .min(2, 'tone must be a set of at least two multi-word descriptors (G2)')

export const brandSetContextSchema = z.object({
  mission: z.string().min(1).optional(),
  audience: z.string().min(1).optional(),
  register: z.string().min(1).optional(),
  toneAttributes: toneAttributesSchema,
  disclosureStatement: z.string().min(1).optional(),
})

export const createSetInputSchema = z.object({
  locale: brandLocaleSchema,
  context: brandSetContextSchema,
  baseSetId: z.string().uuid().optional(),
})

export const updateSetInputSchema = z.object({
  setId: z.string().uuid(),
  context: brandSetContextSchema.partial(),
})

// ---------------------------------------------------------------------------
// Visual sets (phase-2d M4/V7): working drafts of the visual identity, one
// active set per company, draft-only writes (G23). Corpus references are
// ids only — the corpus is a static module artifact, not a store concern.
// ---------------------------------------------------------------------------

function nonEmptyVars(message: string) {
  return z
    .record(z.string(), z.string())
    .refine((vars) => Object.keys(vars).length > 0, { message })
}

export const createVisualSetInputSchema = z.object({
  name: z.string().trim().min(1, 'name is required'),
  sourceItemId: z.string().uuid().optional(),
  pickedItemIds: z
    .array(z.string().uuid())
    .min(1, 'pickedItemIds requires at least one picked corpus item — there is no selection without picks'),
  cssVars: nonEmptyVars('cssVars must not be empty — a visual set without resolved tokens is meaningless (V3)'),
  darkCssVars: z.record(z.string(), z.string()).optional(),
  seeds: brandSeedsSchema.nullable().optional(),
})

export const updateVisualSetInputSchema = z.object({
  setId: z.string().uuid(),
  name: z.string().trim().min(1).optional(),
  pickedItemIds: z.array(z.string().uuid()).min(1).optional(),
  cssVars: nonEmptyVars('cssVars must not be empty — a visual set without resolved tokens is meaningless (V3)').optional(),
  darkCssVars: z.record(z.string(), z.string()).nullable().optional(),
  seeds: brandSeedsSchema.nullable().optional(),
  /** Owner-pinned resolved values (V3: pins beat re-expansion; 'dark:'-prefixed keys pin dark tokens). */
  pins: z.record(z.string(), z.string()).optional(),
})

export type BrandVisualSet = {
  id: string
  status: BrandSetStatus
  name: string
  sourceItemId: string | null
  pickedItemIds: string[]
  seeds: BrandSeeds | null
  cssVars: Record<string, string>
  darkCssVars: Record<string, string> | null
  pins: Record<string, string>
  createdAt: string
  updatedAt: string
}

export type CreateVisualSetInput = z.infer<typeof createVisualSetInputSchema>
export type UpdateVisualSetInput = z.infer<typeof updateVisualSetInputSchema>

/**
 * The cssVar roles a visual set must resolve before it can go live (V9): the
 * shadcn `:root` surface the whole app consumes, plus type. Absence is not a
 * fallback — an incomplete set fails activation loud, listing every gap.
 */
export const REQUIRED_VISUAL_ROLES = [
  'background',
  'foreground',
  'card',
  'popover',
  'primary',
  'primary-foreground',
  'secondary',
  'muted',
  'accent',
  'border',
  'input',
  'ring',
  'radius',
  'font-sans',
  'font-display',
  'font-mono',
] as const

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

export type CreateSetInput = z.infer<typeof createSetInputSchema>
export type UpdateSetInput = z.infer<typeof updateSetInputSchema>

export type ListSetsFilter = {
  status?: BrandSetStatus
  locale?: string
}

export type BrandStore = {
  createSet(input: CreateSetInput): Promise<BrandGuidelineSet>
  getSet(setId: string): Promise<BrandGuidelineSet | null>
  listSets(filter?: ListSetsFilter): Promise<BrandGuidelineSet[]>
  /** Patch the context of a DRAFT set. Active/retired sets are immutable (G23). */
  updateDraftSet(input: UpdateSetInput): Promise<BrandGuidelineSet>
  /**
   * The go-live flip (G8/D5): draft only, requires exemplar-first voice (>=2
   * examples with >=1 good and >=1 bad), CARE-complete context, and at most
   * one active set per locale (D3).
   */
  activateSet(setId: string): Promise<BrandGuidelineSet>
  /** The one legal implicit-free resolution path (G23): fail loud when the locale has no active set. */
  getActiveSet(locale: string): Promise<BrandGuidelineSet>
  addVoiceExample(input: {
    setId: string
    contentType: string
    situation?: string
    body: string
    label: 'good' | 'bad'
    rationale?: string
  }): Promise<BrandVoiceExample>
  addLexiconEntry(input: {
    setId: string
    term: string
    kind: 'allowed' | 'banned' | 'required'
    contextKey?: string
    replacement?: string
  }): Promise<BrandLexiconEntry>
  addCriterion(input: {
    setId: string
    contentType: string
    criterion: string
    kind: 'deterministic' | 'judge'
    spec: Record<string, unknown>
    riskTier: BrandRiskTier
  }): Promise<BrandCriterion>
  addVisualToken(input: {
    setId: string
    token: string
    value: string
    proseRationale?: string
    styleVocabulary?: string[]
  }): Promise<BrandVisualToken>
  addGlossaryEntry(input: {
    setId: string
    term: string
    definition: string
    usageNote?: string
  }): Promise<BrandGlossaryEntry>
  listVoiceExamples(setId: string): Promise<BrandVoiceExample[]>
  listLexicon(setId: string): Promise<BrandLexiconEntry[]>
  listCriteria(setId: string): Promise<BrandCriterion[]>

  // Visual sets (phase-2d M4): draft-only writes, one active set per company.
  /** Create a draft visual set from a wizard selection (requires resolved cssVars, V3). */
  createVisualSet(input: CreateVisualSetInput): Promise<BrandVisualSet>
  getVisualSet(setId: string): Promise<BrandVisualSet | null>
  listVisualSets(): Promise<BrandVisualSet[]>
  /**
   * The company's active visual set, or null when none is active. Null is a
   * legit state (the app keeps its own style), not a fallback; every other
   * failure throws loud (G23: no implicit resolution).
   */
  findActiveVisualSet(): Promise<BrandVisualSet | null>
  /** Fail-loud resolution of the company's active visual set (no implicit latest, G23). */
  getActiveVisualSet(): Promise<BrandVisualSet>
  /** Patch a DRAFT visual set. Active/retired sets are immutable (G23). */
  updateVisualSet(input: UpdateVisualSetInput): Promise<BrandVisualSet>
  /**
   * The approval-gated go-live flip (V9): draft only, complete cssVars
   * (REQUIRED_VISUAL_ROLES). Activating retires the previously active set in
   * the same operation — guards run first so a failed activation leaves the
   * current active set untouched.
   */
  activateVisualSet(setId: string): Promise<BrandVisualSet>
}

function requireDraft(set: BrandGuidelineSet, action: string): BrandGuidelineSet {
  if (set.status !== 'draft') {
    throw new Error(
      `brand guideline set ${set.id} is ${set.status}; ${action} is only allowed on draft sets (G23: active sets are immutable)`,
    )
  }
  return set
}

function requireDraftVisualSet(set: BrandVisualSet, action: string): BrandVisualSet {
  if (set.status !== 'draft') {
    throw new Error(
      `brand visual set ${set.id} is ${set.status}; ${action} is only allowed on draft sets (G23: active sets are immutable)`,
    )
  }
  return set
}

/**
 * Visual activation guards (V9), mirroring the guideline-set assertActivatable:
 * draft-only, and the resolved cssVars must cover every required role — an
 * incomplete set would leave consuming surfaces without tokens, so it fails
 * loud naming the gaps instead of emitting a partial override.
 */
function assertVisualSetActivatable(set: BrandVisualSet): void {
  requireDraftVisualSet(set, 'activation')
  const missing = REQUIRED_VISUAL_ROLES.filter((role) => {
    const value = set.cssVars[`--${role}`]
    return value === undefined || value.trim().length === 0
  })
  if (missing.length > 0) {
    throw new Error(
      `brand visual set ${set.id} cannot activate: cssVars is missing required roles (${missing.map((role) => `--${role}`).join(', ')})`,
    )
  }
}

/** Each corpus item may be picked once — a duplicated pick would double its weight in the centroid. */
function assertNoDuplicatePicks(pickedItemIds: readonly string[]): void {
  if (new Set(pickedItemIds).size !== pickedItemIds.length) {
    throw new Error('pickedItemIds contains duplicates — each corpus item may be picked once')
  }
}

/** Activation guards shared by both store implementations (G2 + D3 + CARE completeness). */
function assertActivatable(
  set: BrandGuidelineSet,
  examples: BrandVoiceExample[],
): void {
  requireDraft(set, 'activation')
  const context = set.context
  for (const field of ['mission', 'audience', 'register'] as const) {
    if (!context[field] || context[field]!.trim().length === 0) {
      throw new Error(
        `brand guideline set ${set.id} cannot activate: context.${field} is required (CARE-complete context, G1)`,
      )
    }
  }
  const good = examples.filter((e) => e.label === 'good').length
  const bad = examples.filter((e) => e.label === 'bad').length
  if (examples.length < 2 || good < 1 || bad < 1) {
    throw new Error(
      `brand guideline set ${set.id} cannot activate: voice is stored exemplar-first (G2) — requires >=2 examples including >=1 good and >=1 bad (has ${good} good / ${bad} bad)`,
    )
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

/** In-memory BrandStore for tests and in-memory kernel wiring. */
export class InMemoryBrandStore implements BrandStore {
  private readonly sets = new Map<string, BrandGuidelineSet>()
  private readonly visualSets = new Map<string, BrandVisualSet>()
  private readonly examples: BrandVoiceExample[] = []
  private readonly lexicon: BrandLexiconEntry[] = []
  private readonly criteria: BrandCriterion[] = []
  private readonly tokens: BrandVisualToken[] = []
  private readonly glossary: BrandGlossaryEntry[] = []

  private requireSet(setId: string): BrandGuidelineSet {
    const set = this.sets.get(setId)
    if (!set) throw new Error(`unknown brand guideline set: ${setId}`)
    return set
  }

  private nextVersion(locale: string): number {
    let max = 0
    for (const set of this.sets.values()) {
      if (set.locale === locale) max = Math.max(max, set.version)
    }
    return max + 1
  }

  async createSet(input: CreateSetInput): Promise<BrandGuidelineSet> {
    const parsed = createSetInputSchema.parse(input)
    const set: BrandGuidelineSet = {
      id: crypto.randomUUID(),
      version: this.nextVersion(parsed.locale),
      locale: parsed.locale,
      status: 'draft',
      context: parsed.context,
      baseSetId: parsed.baseSetId ?? null,
      activatedAt: null,
      validationRunId: null,
      eventId: null,
      createdAt: nowIso(),
    }
    this.sets.set(set.id, set)
    return set
  }

  async getSet(setId: string): Promise<BrandGuidelineSet | null> {
    return this.sets.get(setId) ?? null
  }

  async listSets(filter: ListSetsFilter = {}): Promise<BrandGuidelineSet[]> {
    return [...this.sets.values()]
      .filter(
        (set) =>
          (filter.status === undefined || set.status === filter.status) &&
          (filter.locale === undefined || set.locale === filter.locale),
      )
      .sort((a, b) => a.locale.localeCompare(b.locale) || b.version - a.version)
  }

  async updateDraftSet(input: UpdateSetInput): Promise<BrandGuidelineSet> {
    const parsed = updateSetInputSchema.parse(input)
    const set = this.requireSet(parsed.setId)
    requireDraft(set, 'context update')
    const updated: BrandGuidelineSet = {
      ...set,
      context: { ...set.context, ...parsed.context },
    }
    this.sets.set(set.id, updated)
    return updated
  }

  async activateSet(setId: string): Promise<BrandGuidelineSet> {
    const set = this.requireSet(setId)
    assertActivatable(
      set,
      this.examples.filter((e) => e.setId === setId),
    )
    for (const other of this.sets.values()) {
      if (other.locale === set.locale && other.status === 'active') {
        throw new Error(
          `locale ${set.locale} already has an active guideline set (${other.id}); retire it first (D3: one active set per locale)`,
        )
      }
    }
    const activated: BrandGuidelineSet = { ...set, status: 'active', activatedAt: nowIso() }
    this.sets.set(set.id, activated)
    return activated
  }

  async getActiveSet(locale: string): Promise<BrandGuidelineSet> {
    for (const set of this.sets.values()) {
      if (set.locale === locale && set.status === 'active') return set
    }
    throw new Error(`no active brand guideline set for locale ${locale} (G23: no implicit latest)`)
  }

  async addVoiceExample(input: {
    setId: string
    contentType: string
    situation?: string
    body: string
    label: 'good' | 'bad'
    rationale?: string
  }): Promise<BrandVoiceExample> {
    this.requireDraftSet(input.setId)
    const example: BrandVoiceExample = {
      id: crypto.randomUUID(),
      setId: input.setId,
      contentType: input.contentType,
      situation: input.situation ?? null,
      body: input.body,
      label: input.label,
      rationale: input.rationale ?? null,
    }
    this.examples.push(example)
    return example
  }

  async addLexiconEntry(input: {
    setId: string
    term: string
    kind: 'allowed' | 'banned' | 'required'
    contextKey?: string
    replacement?: string
  }): Promise<BrandLexiconEntry> {
    this.requireDraftSet(input.setId)
    if (this.lexicon.some((e) => e.setId === input.setId && e.term === input.term)) {
      throw new Error(`duplicate lexicon term "${input.term}" in set ${input.setId}`)
    }
    const entry: BrandLexiconEntry = {
      id: crypto.randomUUID(),
      setId: input.setId,
      term: input.term,
      kind: input.kind,
      contextKey: input.contextKey ?? null,
      replacement: input.replacement ?? null,
    }
    this.lexicon.push(entry)
    return entry
  }

  async addCriterion(input: {
    setId: string
    contentType: string
    criterion: string
    kind: 'deterministic' | 'judge'
    spec: Record<string, unknown>
    riskTier: BrandRiskTier
  }): Promise<BrandCriterion> {
    this.requireDraftSet(input.setId)
    const key = `${input.contentType}::${input.criterion}`
    if (
      this.criteria.some((c) => c.setId === input.setId && `${c.contentType}::${c.criterion}` === key)
    ) {
      throw new Error(`duplicate criterion "${input.criterion}" for ${input.contentType} in set ${input.setId}`)
    }
    const criterion: BrandCriterion = { id: crypto.randomUUID(), ...input }
    this.criteria.push(criterion)
    return criterion
  }

  async addVisualToken(input: {
    setId: string
    token: string
    value: string
    proseRationale?: string
    styleVocabulary?: string[]
  }): Promise<BrandVisualToken> {
    this.requireDraftSet(input.setId)
    if (this.tokens.some((t) => t.setId === input.setId && t.token === input.token)) {
      throw new Error(`duplicate visual token "${input.token}" in set ${input.setId}`)
    }
    const token: BrandVisualToken = {
      id: crypto.randomUUID(),
      setId: input.setId,
      token: input.token,
      value: input.value,
      proseRationale: input.proseRationale ?? null,
      styleVocabulary: input.styleVocabulary ?? [],
    }
    this.tokens.push(token)
    return token
  }

  async addGlossaryEntry(input: {
    setId: string
    term: string
    definition: string
    usageNote?: string
  }): Promise<BrandGlossaryEntry> {
    this.requireDraftSet(input.setId)
    if (this.glossary.some((g) => g.setId === input.setId && g.term === input.term)) {
      throw new Error(`duplicate glossary term "${input.term}" in set ${input.setId}`)
    }
    const entry: BrandGlossaryEntry = {
      id: crypto.randomUUID(),
      setId: input.setId,
      term: input.term,
      definition: input.definition,
      usageNote: input.usageNote ?? null,
    }
    this.glossary.push(entry)
    return entry
  }

  async listVoiceExamples(setId: string): Promise<BrandVoiceExample[]> {
    return this.examples.filter((e) => e.setId === setId)
  }

  async listLexicon(setId: string): Promise<BrandLexiconEntry[]> {
    return this.lexicon.filter((e) => e.setId === setId)
  }

  async listCriteria(setId: string): Promise<BrandCriterion[]> {
    return this.criteria.filter((c) => c.setId === setId)
  }

  private requireDraftSet(setId: string): BrandGuidelineSet {
    return requireDraft(this.requireSet(setId), 'curation writes')
  }

  // -- Visual sets (phase-2d M4) -------------------------------------------

  async createVisualSet(input: CreateVisualSetInput): Promise<BrandVisualSet> {
    const parsed = createVisualSetInputSchema.parse(input)
    assertNoDuplicatePicks(parsed.pickedItemIds)
    const set: BrandVisualSet = {
      id: crypto.randomUUID(),
      status: 'draft',
      name: parsed.name,
      sourceItemId: parsed.sourceItemId ?? null,
      pickedItemIds: [...parsed.pickedItemIds],
      seeds: parsed.seeds ?? null,
      cssVars: { ...parsed.cssVars },
      darkCssVars: parsed.darkCssVars ? { ...parsed.darkCssVars } : null,
      pins: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.visualSets.set(set.id, set)
    return set
  }

  async getVisualSet(setId: string): Promise<BrandVisualSet | null> {
    return this.visualSets.get(setId) ?? null
  }

  async listVisualSets(): Promise<BrandVisualSet[]> {
    return [...this.visualSets.values()].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? -1 : 1),
    )
  }

  async getActiveVisualSet(): Promise<BrandVisualSet> {
    const active = await this.findActiveVisualSet()
    if (!active) {
      throw new Error(
        'no active brand visual set (activation is the M5 publish gate; absence of an active set means the app keeps its own style — never a fallback)',
      )
    }
    return active
  }

  async findActiveVisualSet(): Promise<BrandVisualSet | null> {
    for (const set of this.visualSets.values()) {
      if (set.status === 'active') return set
    }
    return null
  }

  async updateVisualSet(input: UpdateVisualSetInput): Promise<BrandVisualSet> {
    const parsed = updateVisualSetInputSchema.parse(input)
    const current = this.visualSets.get(parsed.setId)
    if (!current) throw new Error(`unknown brand visual set: ${parsed.setId}`)
    requireDraftVisualSet(current, 'updates')
    const updated: BrandVisualSet = {
      ...current,
      name: parsed.name ?? current.name,
      pickedItemIds: parsed.pickedItemIds
        ? (assertNoDuplicatePicks(parsed.pickedItemIds), [...parsed.pickedItemIds])
        : current.pickedItemIds,
      cssVars: parsed.cssVars ?? current.cssVars,
      darkCssVars: parsed.darkCssVars === undefined ? current.darkCssVars : parsed.darkCssVars,
      seeds: parsed.seeds === undefined ? current.seeds : parsed.seeds,
      pins: parsed.pins === undefined ? current.pins : parsed.pins,
      updatedAt: nowIso(),
    }
    this.visualSets.set(updated.id, updated)
    return updated
  }

  async activateVisualSet(setId: string): Promise<BrandVisualSet> {
    // Guards run BEFORE any mutation (the guideline-set activation order):
    // a failed activation must leave the currently active set untouched.
    const set = this.visualSets.get(setId)
    if (!set) throw new Error(`unknown brand visual set: ${setId}`)
    assertVisualSetActivatable(set)
    const previous = [...this.visualSets.values()].find(
      (other) => other.id !== setId && other.status === 'active',
    )
    if (previous) {
      this.visualSets.set(previous.id, {
        ...previous,
        status: 'retired',
        updatedAt: nowIso(),
      })
    }
    const activated: BrandVisualSet = { ...set, status: 'active', updatedAt: nowIso() }
    this.visualSets.set(activated.id, activated)
    return activated
  }
}

// ---------------------------------------------------------------------------
// DB-backed store
// ---------------------------------------------------------------------------

type SetRow = typeof brandGuidelineSets.$inferSelect
type ExampleRow = typeof brandVoiceExamples.$inferSelect
type LexiconRow = typeof brandLexicon.$inferSelect
type CriterionRow = typeof brandCriteria.$inferSelect
type TokenRow = typeof brandVisualTokens.$inferSelect
type GlossaryRow = typeof brandGlossary.$inferSelect
type VisualSetRow = typeof brandVisualSets.$inferSelect

function toSet(row: SetRow): BrandGuidelineSet {
  return {
    id: row.id,
    version: row.version,
    locale: row.locale,
    status: row.status,
    context: row.context,
    baseSetId: row.baseSetId,
    activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
    validationRunId: row.validationRunId,
    eventId: row.eventId,
    createdAt: row.createdAt.toISOString(),
  }
}

function toExample(row: ExampleRow): BrandVoiceExample {
  return {
    id: row.id,
    setId: row.setId,
    contentType: row.contentType,
    situation: row.situation,
    body: row.body,
    label: row.label,
    rationale: row.rationale,
  }
}

function toLexiconEntry(row: LexiconRow): BrandLexiconEntry {
  return {
    id: row.id,
    setId: row.setId,
    term: row.term,
    kind: row.kind,
    contextKey: row.contextKey,
    replacement: row.replacement,
  }
}

function toCriterion(row: CriterionRow): BrandCriterion {
  return {
    id: row.id,
    setId: row.setId,
    contentType: row.contentType,
    criterion: row.criterion,
    kind: row.kind,
    spec: row.spec,
    riskTier: row.riskTier,
  }
}

function toToken(row: TokenRow): BrandVisualToken {
  return {
    id: row.id,
    setId: row.setId,
    token: row.token,
    value: row.value,
    proseRationale: row.proseRationale,
    styleVocabulary: row.styleVocabulary,
  }
}

function toGlossaryEntry(row: GlossaryRow): BrandGlossaryEntry {
  return {
    id: row.id,
    setId: row.setId,
    term: row.term,
    definition: row.definition,
    usageNote: row.usageNote,
  }
}

function toVisualSet(row: VisualSetRow): BrandVisualSet {
  return {
    id: row.id,
    status: row.status,
    name: row.name,
    sourceItemId: row.sourceItemId,
    pickedItemIds: row.pickedItemIds,
    // Re-validate stored seeds — DB integrity is checked, not trusted.
    seeds: row.seeds ? brandSeedsSchema.parse(row.seeds) : null,
    cssVars: row.cssVars,
    darkCssVars: row.darkCssVars ?? null,
    pins: row.pins,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function resolveDb(db: DbHandle) {
  return typeof db === 'function' ? await db() : db
}

async function requireDbSet(database: Awaited<ReturnType<typeof resolveDb>>, setId: string): Promise<BrandGuidelineSet> {
  const rows = await database
    .select()
    .from(brandGuidelineSets)
    .where(eq(brandGuidelineSets.id, setId))
    .limit(1)
  if (!rows[0]) throw new Error(`unknown brand guideline set: ${setId}`)
  return toSet(rows[0])
}

async function requireDbVisualSet(
  database: Awaited<ReturnType<typeof resolveDb>>,
  setId: string,
): Promise<BrandVisualSet> {
  const rows = await database
    .select()
    .from(brandVisualSets)
    .where(eq(brandVisualSets.id, setId))
    .limit(1)
  if (!rows[0]) throw new Error(`unknown brand visual set: ${setId}`)
  return toVisualSet(rows[0])
}

/**
 * BrandStore persisting to the brand_* tables. Uniqueness is enforced by
 * explicit lookups with the DB constraints (unique indexes + CHECKs from
 * migration 0076) as backstop; every path fails loud.
 */
export class DbBrandStore implements BrandStore {
  constructor(private readonly db: DbHandle) {}

  async createSet(input: CreateSetInput): Promise<BrandGuidelineSet> {
    const parsed = createSetInputSchema.parse(input)
    const database = await resolveDb(this.db)
    const [{ maxVersion } = { maxVersion: null }] = await database
      .select({ maxVersion: sql<number | null>`max(${brandGuidelineSets.version})` })
      .from(brandGuidelineSets)
      .where(eq(brandGuidelineSets.locale, parsed.locale))
    const rows = await database
      .insert(brandGuidelineSets)
      .values({
        version: (maxVersion ?? 0) + 1,
        locale: parsed.locale,
        status: 'draft',
        context: parsed.context,
        baseSetId: parsed.baseSetId ?? null,
      })
      .returning()
    if (!rows[0]) throw new Error('brand guideline set insert returned no row')
    return toSet(rows[0])
  }

  async getSet(setId: string): Promise<BrandGuidelineSet | null> {
    const database = await resolveDb(this.db)
    const rows = await database
      .select()
      .from(brandGuidelineSets)
      .where(eq(brandGuidelineSets.id, setId))
      .limit(1)
    return rows[0] ? toSet(rows[0]) : null
  }

  async listSets(filter: ListSetsFilter = {}): Promise<BrandGuidelineSet[]> {
    const database = await resolveDb(this.db)
    const conditions = [
      ...(filter.status === undefined ? [] : [eq(brandGuidelineSets.status, filter.status)]),
      ...(filter.locale === undefined ? [] : [eq(brandGuidelineSets.locale, filter.locale)]),
    ]
    const rows = await database
      .select()
      .from(brandGuidelineSets)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(brandGuidelineSets.locale, desc(brandGuidelineSets.version))
    return rows.map(toSet)
  }

  async updateDraftSet(input: UpdateSetInput): Promise<BrandGuidelineSet> {
    const parsed = updateSetInputSchema.parse(input)
    const database = await resolveDb(this.db)
    const current = await requireDbSet(database, parsed.setId)
    requireDraft(current, 'context update')
    const rows = await database
      .update(brandGuidelineSets)
      .set({ context: { ...current.context, ...parsed.context } })
      .where(eq(brandGuidelineSets.id, parsed.setId))
      .returning()
    if (!rows[0]) throw new Error(`brand guideline set update returned no row: ${parsed.setId}`)
    return toSet(rows[0])
  }

  async activateSet(setId: string): Promise<BrandGuidelineSet> {
    const database = await resolveDb(this.db)
    const set = await requireDbSet(database, setId)
    const examples = (
      await database.select().from(brandVoiceExamples).where(eq(brandVoiceExamples.setId, setId))
    ).map(toExample)
    assertActivatable(set, examples)

    const activeRows = await database
      .select({ id: brandGuidelineSets.id })
      .from(brandGuidelineSets)
      .where(
        and(
          eq(brandGuidelineSets.locale, set.locale),
          eq(brandGuidelineSets.status, 'active'),
          ne(brandGuidelineSets.id, setId),
        ),
      )
      .limit(1)
    if (activeRows[0]) {
      throw new Error(
        `locale ${set.locale} already has an active guideline set (${activeRows[0].id}); retire it first (D3: one active set per locale)`,
      )
    }

    const rows = await database
      .update(brandGuidelineSets)
      .set({ status: 'active', activatedAt: new Date() })
      .where(eq(brandGuidelineSets.id, setId))
      .returning()
    if (!rows[0]) throw new Error(`brand guideline set activation returned no row: ${setId}`)
    return toSet(rows[0])
  }

  async getActiveSet(locale: string): Promise<BrandGuidelineSet> {
    const database = await resolveDb(this.db)
    const rows = await database
      .select()
      .from(brandGuidelineSets)
      .where(and(eq(brandGuidelineSets.locale, locale), eq(brandGuidelineSets.status, 'active')))
      .limit(1)
    if (!rows[0]) {
      throw new Error(`no active brand guideline set for locale ${locale} (G23: no implicit latest)`)
    }
    return toSet(rows[0])
  }

  async addVoiceExample(input: {
    setId: string
    contentType: string
    situation?: string
    body: string
    label: 'good' | 'bad'
    rationale?: string
  }): Promise<BrandVoiceExample> {
    const database = await resolveDb(this.db)
    await requireDbDraft(database, input.setId, 'curation writes')
    const rows = await database
      .insert(brandVoiceExamples)
      .values({
        setId: input.setId,
        contentType: input.contentType,
        situation: input.situation ?? null,
        body: input.body,
        label: input.label,
        rationale: input.rationale ?? null,
      })
      .returning()
    if (!rows[0]) throw new Error('brand voice example insert returned no row')
    return toExample(rows[0])
  }

  async addLexiconEntry(input: {
    setId: string
    term: string
    kind: 'allowed' | 'banned' | 'required'
    contextKey?: string
    replacement?: string
  }): Promise<BrandLexiconEntry> {
    const database = await resolveDb(this.db)
    await requireDbDraft(database, input.setId, 'curation writes')
    const existing = await database
      .select({ id: brandLexicon.id })
      .from(brandLexicon)
      .where(and(eq(brandLexicon.setId, input.setId), eq(brandLexicon.term, input.term)))
      .limit(1)
    if (existing[0]) {
      throw new Error(`duplicate lexicon term "${input.term}" in set ${input.setId}`)
    }
    const rows = await database
      .insert(brandLexicon)
      .values({
        setId: input.setId,
        term: input.term,
        kind: input.kind,
        contextKey: input.contextKey ?? null,
        replacement: input.replacement ?? null,
      })
      .returning()
    if (!rows[0]) throw new Error('brand lexicon insert returned no row')
    return toLexiconEntry(rows[0])
  }

  async addCriterion(input: {
    setId: string
    contentType: string
    criterion: string
    kind: 'deterministic' | 'judge'
    spec: Record<string, unknown>
    riskTier: BrandRiskTier
  }): Promise<BrandCriterion> {
    const database = await resolveDb(this.db)
    await requireDbDraft(database, input.setId, 'curation writes')
    const existing = await database
      .select({ id: brandCriteria.id })
      .from(brandCriteria)
      .where(
        and(
          eq(brandCriteria.setId, input.setId),
          eq(brandCriteria.contentType, input.contentType),
          eq(brandCriteria.criterion, input.criterion),
        ),
      )
      .limit(1)
    if (existing[0]) {
      throw new Error(
        `duplicate criterion "${input.criterion}" for ${input.contentType} in set ${input.setId}`,
      )
    }
    const rows = await database.insert(brandCriteria).values(input).returning()
    if (!rows[0]) throw new Error('brand criteria insert returned no row')
    return toCriterion(rows[0])
  }

  async addVisualToken(input: {
    setId: string
    token: string
    value: string
    proseRationale?: string
    styleVocabulary?: string[]
  }): Promise<BrandVisualToken> {
    const database = await resolveDb(this.db)
    await requireDbDraft(database, input.setId, 'curation writes')
    const existing = await database
      .select({ id: brandVisualTokens.id })
      .from(brandVisualTokens)
      .where(and(eq(brandVisualTokens.setId, input.setId), eq(brandVisualTokens.token, input.token)))
      .limit(1)
    if (existing[0]) {
      throw new Error(`duplicate visual token "${input.token}" in set ${input.setId}`)
    }
    const rows = await database
      .insert(brandVisualTokens)
      .values({
        setId: input.setId,
        token: input.token,
        value: input.value,
        proseRationale: input.proseRationale ?? null,
        styleVocabulary: input.styleVocabulary ?? [],
      })
      .returning()
    if (!rows[0]) throw new Error('brand visual token insert returned no row')
    return toToken(rows[0])
  }

  async addGlossaryEntry(input: {
    setId: string
    term: string
    definition: string
    usageNote?: string
  }): Promise<BrandGlossaryEntry> {
    const database = await resolveDb(this.db)
    await requireDbDraft(database, input.setId, 'curation writes')
    const existing = await database
      .select({ id: brandGlossary.id })
      .from(brandGlossary)
      .where(and(eq(brandGlossary.setId, input.setId), eq(brandGlossary.term, input.term)))
      .limit(1)
    if (existing[0]) {
      throw new Error(`duplicate glossary term "${input.term}" in set ${input.setId}`)
    }
    const rows = await database
      .insert(brandGlossary)
      .values({
        setId: input.setId,
        term: input.term,
        definition: input.definition,
        usageNote: input.usageNote ?? null,
      })
      .returning()
    if (!rows[0]) throw new Error('brand glossary insert returned no row')
    return toGlossaryEntry(rows[0])
  }

  async listVoiceExamples(setId: string): Promise<BrandVoiceExample[]> {
    const database = await resolveDb(this.db)
    const rows = await database
      .select()
      .from(brandVoiceExamples)
      .where(eq(brandVoiceExamples.setId, setId))
      .orderBy(brandVoiceExamples.createdAt)
    return rows.map(toExample)
  }

  async listLexicon(setId: string): Promise<BrandLexiconEntry[]> {
    const database = await resolveDb(this.db)
    const rows = await database
      .select()
      .from(brandLexicon)
      .where(eq(brandLexicon.setId, setId))
      .orderBy(brandLexicon.term)
    return rows.map(toLexiconEntry)
  }

  async listCriteria(setId: string): Promise<BrandCriterion[]> {
    const database = await resolveDb(this.db)
    const rows = await database
      .select()
      .from(brandCriteria)
      .where(eq(brandCriteria.setId, setId))
      .orderBy(brandCriteria.contentType, brandCriteria.criterion)
    return rows.map(toCriterion)
  }

  // -- Visual sets (phase-2d M4) -------------------------------------------

  async createVisualSet(input: CreateVisualSetInput): Promise<BrandVisualSet> {
    const parsed = createVisualSetInputSchema.parse(input)
    assertNoDuplicatePicks(parsed.pickedItemIds)
    const database = await resolveDb(this.db)
    const rows = await database
      .insert(brandVisualSets)
      .values({
        status: 'draft',
        name: parsed.name,
        sourceItemId: parsed.sourceItemId ?? null,
        pickedItemIds: [...parsed.pickedItemIds],
        seeds: parsed.seeds ?? null,
        cssVars: parsed.cssVars,
        darkCssVars: parsed.darkCssVars ?? null,
        pins: {},
      })
      .returning()
    if (!rows[0]) throw new Error('brand visual set insert returned no row')
    return toVisualSet(rows[0])
  }

  async getVisualSet(setId: string): Promise<BrandVisualSet | null> {
    const database = await resolveDb(this.db)
    const rows = await database
      .select()
      .from(brandVisualSets)
      .where(eq(brandVisualSets.id, setId))
      .limit(1)
    return rows[0] ? toVisualSet(rows[0]) : null
  }

  async listVisualSets(): Promise<BrandVisualSet[]> {
    const database = await resolveDb(this.db)
    const rows = await database
      .select()
      .from(brandVisualSets)
      .orderBy(desc(brandVisualSets.createdAt), brandVisualSets.id)
    return rows.map(toVisualSet)
  }

  async getActiveVisualSet(): Promise<BrandVisualSet> {
    const active = await this.findActiveVisualSet()
    if (!active) {
      throw new Error(
        'no active brand visual set (activation is the M5 publish gate; absence of an active set means the app keeps its own style — never a fallback)',
      )
    }
    return active
  }

  async findActiveVisualSet(): Promise<BrandVisualSet | null> {
    const database = await resolveDb(this.db)
    const rows = await database
      .select()
      .from(brandVisualSets)
      .where(eq(brandVisualSets.status, 'active'))
      .limit(1)
    return rows[0] ? toVisualSet(rows[0]) : null
  }

  async updateVisualSet(input: UpdateVisualSetInput): Promise<BrandVisualSet> {
    const parsed = updateVisualSetInputSchema.parse(input)
    const database = await resolveDb(this.db)
    const current = await requireDbVisualSet(database, parsed.setId)
    requireDraftVisualSet(current, 'updates')
    if (parsed.pickedItemIds) assertNoDuplicatePicks(parsed.pickedItemIds)
    const rows = await database
      .update(brandVisualSets)
      .set({
        ...(parsed.name === undefined ? {} : { name: parsed.name }),
        ...(parsed.pickedItemIds === undefined ? {} : { pickedItemIds: [...parsed.pickedItemIds] }),
        ...(parsed.cssVars === undefined ? {} : { cssVars: parsed.cssVars }),
        ...(parsed.darkCssVars === undefined ? {} : { darkCssVars: parsed.darkCssVars }),
        ...(parsed.seeds === undefined ? {} : { seeds: parsed.seeds }),
        ...(parsed.pins === undefined ? {} : { pins: parsed.pins }),
        updatedAt: new Date(),
      })
      .where(eq(brandVisualSets.id, parsed.setId))
      .returning()
    if (!rows[0]) throw new Error(`brand visual set update returned no row: ${parsed.setId}`)
    return toVisualSet(rows[0])
  }

  async activateVisualSet(setId: string): Promise<BrandVisualSet> {
    const database = await resolveDb(this.db)
    // Guards run BEFORE any mutation (the guideline-set activation order):
    // draft-only + complete cssVars, so a failed activation leaves the
    // currently active set untouched. Then the transactional order mirrors
    // set_activate's guard-then-flip shape: retire the previous active set,
    // then flip this one — never two active sets.
    const set = await requireDbVisualSet(database, setId)
    assertVisualSetActivatable(set)
    const activeRows = await database
      .select({ id: brandVisualSets.id })
      .from(brandVisualSets)
      .where(and(eq(brandVisualSets.status, 'active'), ne(brandVisualSets.id, setId)))
      .limit(1)
    if (activeRows[0]) {
      const retired = await database
        .update(brandVisualSets)
        .set({ status: 'retired', updatedAt: new Date() })
        .where(eq(brandVisualSets.id, activeRows[0].id))
        .returning()
      if (!retired[0]) {
        throw new Error(`brand visual set retirement returned no row: ${activeRows[0].id}`)
      }
    }
    const rows = await database
      .update(brandVisualSets)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(brandVisualSets.id, setId))
      .returning()
    if (!rows[0]) throw new Error(`brand visual set activation returned no row: ${setId}`)
    return toVisualSet(rows[0])
  }
}

async function requireDbDraft(
  database: Awaited<ReturnType<typeof resolveDb>>,
  setId: string,
  action: string,
): Promise<BrandGuidelineSet> {
  return requireDraft(await requireDbSet(database, setId), action)
}

/**
 * Production store handle: lazily resolves the request-scoped DB (when inside
 * a request/ALS context) or the pooled app handle, so importing/wiring never
 * opens a connection (same idiom as defaultWebsiteStore).
 */
export function defaultBrandStore(): BrandStore {
  const db: DbHandle = async () => {
    const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
    const scoped = appDbAsyncLocal.getStore()
    if (scoped) return scoped
    return createScopedDrizzle(appSql)
  }
  return new DbBrandStore(db)
}
