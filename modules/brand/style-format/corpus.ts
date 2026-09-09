import { z } from 'zod'
import { brandSeedsSchema, type BrandSeeds } from './seeds'

/**
 * Corpus item type (phase-2d). A corpus entry pins one fully expanded design
 * system (seeds + expanded token sets) with provenance. The corpus JSON files
 * themselves are M3 — this module ships only the contract + validation.
 */

export const corpusProvenanceSchema = z.object({
  source: z.enum(['extraction', 'tier1', 'archetype']),
  url: z.string().url().optional(),
  capturedAt: z.string().datetime().optional(),
  /** Free-text provenance detail (theme name, preset id, author note). */
  note: z.string().min(1).optional(),
})

export const corpusItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  seeds: brandSeedsSchema,
  cssVars: z.record(z.string(), z.string()),
  darkCssVars: z.record(z.string(), z.string()),
  provenance: corpusProvenanceSchema,
  createdAt: z.string().datetime(),
})

export type BrandCorpusItem = z.infer<typeof corpusItemSchema>

/** Fail-loud validation: throws with the exact zod issue list on violation. */
export function validateCorpusItem(item: unknown): BrandCorpusItem {
  const result = corpusItemSchema.safeParse(item)
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`invalid corpus item: ${detail}`)
  }
  return result.data
}

export type { BrandSeeds }
