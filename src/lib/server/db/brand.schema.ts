import { index, integer, jsonb, pgTable, real, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'

/**
 * Brand kernel tables (phase-2c) — the company's brand as executable context.
 * Ruleset of record: plan/branding-module-rules.md; consumed only by
 * modules/brand stores (same pattern as website.schema.ts). Guideline sets are
 * immutable versions (draft -> active -> retired); child curation tables are
 * only writable while their set is a draft (store-enforced).
 */

export type BrandGuidelineSetContext = {
  mission?: string
  audience?: string
  register?: string
  /** Multi-word nuanced tone descriptor sets (G2: single tone words rejected at schema level). */
  toneAttributes?: string[]
  /** Site-level AI-disclosure statement (D4; per-asset flag overrides). */
  disclosureStatement?: string
}

export const brandGuidelineSets = pgTable('brand_guideline_sets', {
  id: uuid('id').primaryKey().defaultRandom(),
  version: integer('version').notNull(),
  locale: text('locale').notNull(),
  status: text('status', { enum: ['draft', 'active', 'retired'] })
    .default('draft')
    .notNull(),
  context: jsonb('context').$type<BrandGuidelineSetContext>().notNull(),
  baseSetId: uuid('base_set_id'),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  validationRunId: uuid('validation_run_id'),
  eventId: uuid('event_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const brandVoiceExamples = pgTable('brand_voice_examples', {
  id: uuid('id').primaryKey().defaultRandom(),
  setId: uuid('set_id')
    .notNull()
    .references(() => brandGuidelineSets.id, { onDelete: 'cascade' }),
  contentType: text('content_type').notNull(),
  situation: text('situation'),
  body: text('body').notNull(),
  label: text('label', { enum: ['good', 'bad'] }).notNull(),
  rationale: text('rationale'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const brandLexicon = pgTable(
  'brand_lexicon',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    setId: uuid('set_id')
      .notNull()
      .references(() => brandGuidelineSets.id, { onDelete: 'cascade' }),
    term: text('term').notNull(),
    kind: text('kind', { enum: ['allowed', 'banned', 'required'] }).notNull(),
    contextKey: text('context_key'),
    replacement: text('replacement'),
  },
  (table) => [index('brand_lexicon_set_term_idx').on(table.setId, table.term)],
)

export const brandVisualTokens = pgTable('brand_visual_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  setId: uuid('set_id')
    .notNull()
    .references(() => brandGuidelineSets.id, { onDelete: 'cascade' }),
  token: text('token').notNull(),
  value: text('value').notNull(),
  proseRationale: text('prose_rationale'),
  styleVocabulary: jsonb('style_vocabulary').$type<string[]>().default([]).notNull(),
})

export const brandGlossary = pgTable('brand_glossary', {
  id: uuid('id').primaryKey().defaultRandom(),
  setId: uuid('set_id')
    .notNull()
    .references(() => brandGuidelineSets.id, { onDelete: 'cascade' }),
  term: text('term').notNull(),
  definition: text('definition').notNull(),
  usageNote: text('usage_note'),
})

export const brandCriteria = pgTable(
  'brand_criteria',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    setId: uuid('set_id')
      .notNull()
      .references(() => brandGuidelineSets.id, { onDelete: 'cascade' }),
    contentType: text('content_type').notNull(),
    criterion: text('criterion').notNull(),
    kind: text('kind', { enum: ['deterministic', 'judge'] }).notNull(),
    spec: jsonb('spec').$type<Record<string, unknown>>().notNull(),
    riskTier: text('risk_tier', { enum: ['low', 'standard', 'heritage'] })
      .default('standard')
      .notNull(),
  },
  (table) => [index('brand_criteria_set_type_idx').on(table.setId, table.contentType)],
)

export const brandAssets = pgTable('brand_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  contentType: text('content_type').notNull(),
  locale: text('locale').notNull(),
  body: text('body').notNull(),
  riskTier: text('risk_tier', { enum: ['low', 'standard', 'heritage'] })
    .default('standard')
    .notNull(),
  guidelineSetId: uuid('guideline_set_id')
    .notNull()
    .references(() => brandGuidelineSets.id),
  provenance: jsonb('provenance').$type<Record<string, unknown>>().default({}).notNull(),
  disclosure: text('disclosure', { enum: ['ai_assisted', 'human_authored'] })
    .default('ai_assisted')
    .notNull(),
  status: text('status', { enum: ['draft', 'validated', 'published', 'rejected'] })
    .default('draft')
    .notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const brandValidations = pgTable('brand_validations', {
  id: uuid('id').primaryKey().defaultRandom(),
  assetId: uuid('asset_id')
    .notNull()
    .references(() => brandAssets.id, { onDelete: 'cascade' }),
  layer: text('layer', { enum: ['deterministic', 'judge'] }).notNull(),
  criterion: text('criterion').notNull(),
  result: text('result', { enum: ['pass', 'fail', 'flag'] }).notNull(),
  rationale: text('rationale'),
  judgeId: text('judge_id'),
  judgeModel: text('judge_model'),
  judgeMetricsRef: uuid('judge_metrics_ref'),
})

export const brandJudgeMetrics = pgTable('brand_judge_metrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  setId: uuid('set_id')
    .notNull()
    .references(() => brandGuidelineSets.id, { onDelete: 'cascade' }),
  judgeId: text('judge_id').notNull(),
  judgeModel: text('judge_model').notNull(),
  f1: real('f1').notNull(),
  precision: real('precision').notNull(),
  recall: real('recall').notNull(),
  calibrationSetRef: text('calibration_set_ref').notNull(),
  measuredAt: timestamp('measured_at', { withTimezone: true }).defaultNow().notNull(),
})

export const brandCalibrationCases = pgTable('brand_calibration_cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  setId: uuid('set_id')
    .notNull()
    .references(() => brandGuidelineSets.id, { onDelete: 'cascade' }),
  contentType: text('content_type').notNull(),
  body: text('body').notNull(),
  expected: jsonb('expected').$type<Record<string, unknown>>().notNull(),
  annotatedBy: text('annotated_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Visual-brand extraction pipeline (phase-2d M2) — sessions, rounds, staging.
// ---------------------------------------------------------------------------

export type BrandExtractionVerdict = {
  chosen: number | null
  note?: string
}

export const brandExtractionSessions = pgTable('brand_extraction_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  url: text('url').notNull(),
  title: text('title'),
  status: text('status', { enum: ['active', 'accepted', 'abandoned'] })
    .default('active')
    .notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const brandExtractionRounds = pgTable(
  'brand_extraction_rounds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => brandExtractionSessions.id, { onDelete: 'cascade' }),
    round: integer('round').notNull(),
    digest: text('digest').notNull(),
    screenshotB64: text('screenshot_b64').notNull(),
    candidates: jsonb('candidates').$type<unknown[]>().notNull(),
    verdict: jsonb('verdict').$type<BrandExtractionVerdict>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique('brand_extraction_rounds_session_round_key').on(table.sessionId, table.round)],
)

export const brandCorpusStaging = pgTable('brand_corpus_staging', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').references(() => brandExtractionSessions.id, {
    onDelete: 'set null',
  }),
  name: text('name').notNull(),
  corpusItem: jsonb('corpus_item').$type<Record<string, unknown>>().notNull(),
  status: text('status', { enum: ['staged', 'exported'] })
    .default('staged')
    .notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Visual brand selection (phase-2d M4/V7) — working drafts of the visual
// identity. One active set per company: single-tenant kernel tables carry no
// company_id (mirrors brand_guideline_sets' one-active pattern from 0076);
// the partial unique index lives in the migration, not here. Draft-only
// writes are enforced in modules/brand/store.ts (G23).
// ---------------------------------------------------------------------------

export const brandVisualSets = pgTable('brand_visual_sets', {
  id: uuid('id').primaryKey().defaultRandom(),
  status: text('status', { enum: ['draft', 'active', 'retired'] })
    .default('draft')
    .notNull(),
  name: text('name').notNull(),
  /** Corpus item (modules/brand/corpus/, static JSON — no FK, V2) the draft came from. */
  sourceItemId: uuid('source_item_id'),
  /** The selection trail: corpus item ids the owner picked in the wizard. */
  pickedItemIds: jsonb('picked_item_ids').$type<string[]>().default([]).notNull(),
  /** Brand-picker node (modules/brand/taxonomy, static JSON — no FK) a picker choice came from. */
  pickerNodeId: text('picker_node_id'),
  seeds: jsonb('seeds').$type<Record<string, unknown>>(),
  cssVars: jsonb('css_vars').$type<Record<string, string>>().notNull(),
  darkCssVars: jsonb('dark_css_vars').$type<Record<string, string>>(),
  /** Owner-pinned resolved values (phase-2d M6, V3): pins beat re-expansion. */
  pins: jsonb('pins').$type<Record<string, string>>().default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
