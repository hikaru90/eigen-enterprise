import { z } from 'zod'

/**
 * Brand-picker style taxonomy (plan/phase-brand-picker.md §3.1, milestone B1).
 *
 * Three levels: genre → style → variant (leaf). Every node carries a name, a
 * one-line description, the axes that distinguish it from its siblings, a
 * token intent (what B2 must author or reuse) and its source: existing corpus
 * items by slug (items/<slug>.json) or "author". This is a PROPOSAL the owner
 * reviews before anything is precompiled — validation is structural only.
 */

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase slug')

export const taxonomyAxisSchema = z.enum([
  'colour-mood',
  'type-pairing',
  'density',
  'shape-language',
  'elevation',
  'motion',
])
export type TaxonomyAxis = z.infer<typeof taxonomyAxisSchema>

export const tokenIntentSchema = z.object({
  /** Real Google Fonts family names (OFL). */
  fonts: z.object({ heading: z.string().min(1), body: z.string().min(1), mono: z.string().min(1) }),
  radius: z.enum(['none', 'xs', 'sm', 'md', 'lg', 'xl', 'pill']),
  /** Palette mood in words (hues, temperature, contrast) — authored into OKLCH in B2. */
  palette: z.string().min(1),
  mode: z.enum(['light', 'dark']),
  density: z.enum(['compact', 'regular', 'airy']),
  elevation: z.enum(['flat', 'subtle', 'layered']),
  border: z.enum(['none', 'hairline', 'bold']),
  motion: z.enum(['productive', 'expressive']),
})
export type TokenIntent = z.infer<typeof tokenIntentSchema>

export const nodeSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('corpus'), slugs: z.array(slug).min(1) }),
  z.object({ kind: z.literal('author') }),
])

const nodeBase = {
  id: slug,
  name: z.string().min(1),
  description: z.string().min(1),
  axes: z.array(taxonomyAxisSchema).min(1),
  intent: tokenIntentSchema,
  source: nodeSourceSchema,
}

export const variantSchema = z.object(nodeBase)
export const styleSchema = z.object({ ...nodeBase, variants: z.array(variantSchema).min(2) })
export const genreSchema = z.object({ ...nodeBase, styles: z.array(styleSchema).min(2) })

export const taxonomySourceSchema = z.object({
  id: slug,
  name: z.string().min(1),
  url: z.string().url(),
  /** Licence as recorded; "reference only" when nothing is copied. */
  licence: z.string().min(1),
  use: z.enum(['tokens', 'fonts', 'reference']),
  note: z.string().min(1).optional(),
})

export const taxonomyDraftSchema = z.object({
  version: z.literal(1),
  status: z.literal('proposal'),
  sources: z.array(taxonomySourceSchema).min(1),
  genres: z.array(genreSchema).min(2),
})

export type TaxonomyVariant = z.infer<typeof variantSchema>
export type TaxonomyStyle = z.infer<typeof styleSchema>
export type TaxonomyGenre = z.infer<typeof genreSchema>
export type TaxonomyDraft = z.infer<typeof taxonomyDraftSchema>
export type TaxonomyNode = TaxonomyGenre | TaxonomyStyle | TaxonomyVariant

export function leavesOf(draft: TaxonomyDraft): TaxonomyVariant[] {
  return draft.genres.flatMap((g) => g.styles.flatMap((s) => s.variants))
}

/** Fail-loud parse: zod issues, then tree-wide id and leaf-mapping uniqueness. */
export function parseTaxonomyDraft(raw: unknown): TaxonomyDraft {
  const result = taxonomyDraftSchema.safeParse(raw)
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`invalid taxonomy draft: ${detail}`)
  }
  const draft = result.data
  const seen = new Set<string>()
  const nodes: TaxonomyNode[] = [...draft.genres, ...draft.genres.flatMap((g) => g.styles), ...leavesOf(draft)]
  for (const node of nodes) {
    if (seen.has(node.id)) throw new Error(`invalid taxonomy draft: duplicate node id "${node.id}"`)
    seen.add(node.id)
  }
  const sourceIds = new Set<string>()
  for (const s of draft.sources) {
    if (sourceIds.has(s.id)) throw new Error(`invalid taxonomy draft: duplicate source id "${s.id}"`)
    sourceIds.add(s.id)
  }
  const mapped = new Set<string>()
  for (const leaf of leavesOf(draft)) {
    if (leaf.source.kind !== 'corpus') continue
    for (const s of leaf.source.slugs) {
      if (mapped.has(s)) throw new Error(`invalid taxonomy draft: corpus item "${s}" mapped to more than one leaf`)
      mapped.add(s)
    }
  }
  return draft
}
