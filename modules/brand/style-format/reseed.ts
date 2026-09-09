import { expandSeeds } from './expand'
import { brandSeedsSchema, type BrandSeeds } from './seeds'

/**
 * Seed propagation for the visual editor (phase-2d M6, V3): merge a seed
 * patch into the draft's seed block, re-expand deterministically, and re-apply
 * the owner's pins on top — "pins beat re-expansion". Pure data transformation;
 * the caller (brand.visual_set_update) owns draft-only guards and persistence.
 */

/** Marks a pin that targets the dark-mode variant of a cssVar (`dark:--background`). */
export const DARK_PIN_PREFIX = 'dark:'

/** Deep-partial seed block as plain JSON (what the editor posts). */
export type SeedPatch = Record<string, unknown>

/** The slice of a draft visual set applySeedEdit needs (BrandVisualSet satisfies this). */
export type DraftWithPins = {
  seeds: BrandSeeds | null
  pins: Record<string, string>
}

export type ReseedResult = {
  seeds: BrandSeeds
  cssVars: Record<string, string>
  darkCssVars: Record<string, string>
  pins: Record<string, string>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Patch semantics: plain objects merge recursively, arrays and scalars replace. */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key]
    out[key] =
      isPlainObject(value) && isPlainObject(current) ? deepMerge(current, value) : value
  }
  return out
}

/**
 * Re-expand a seed-backed draft after a seed edit. Fails loud when the draft
 * carries no seed block — there is no canonical expansion to re-flow through,
 * so seed editing is meaningless there (edit resolved values / pins instead).
 * Deterministic: identical draft + patch always produce identical output.
 */
export function applySeedEdit(draft: DraftWithPins, seedPatch: SeedPatch): ReseedResult {
  if (!draft.seeds) {
    throw new Error(
      'visual set has no seeds: seed editing requires a seed-backed draft — edit resolved values (pins) instead',
    )
  }
  const merged = brandSeedsSchema.parse(deepMerge(draft.seeds, seedPatch))
  const expanded = expandSeeds(merged)
  const cssVars = { ...expanded.cssVars }
  const darkCssVars = { ...expanded.darkCssVars }
  // V3 override semantics: pinned resolved values sit ON TOP of the expansion.
  for (const [key, value] of Object.entries(draft.pins)) {
    if (key.startsWith(DARK_PIN_PREFIX)) {
      darkCssVars[key.slice(DARK_PIN_PREFIX.length)] = value
    } else {
      cssVars[key] = value
    }
  }
  return { seeds: merged, cssVars, darkCssVars, pins: { ...draft.pins } }
}
