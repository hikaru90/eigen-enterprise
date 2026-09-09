import type { ModuleManifest } from '$lib/kernel/modules'

/** Tool names owned by the brand module (single source of truth for the manifest). */
export const BRAND_TOOL_NAMES = [
  'brand.set_create',
  'brand.set_update',
  'brand.set_activate',
  'brand.set_get',
  'brand.set_list',
  'brand.example_add',
  'brand.lexicon_add',
  'brand.criterion_add',
  'brand.token_add',
  'brand.glossary_add',
  'brand.extract_start',
  'brand.extract_propose',
  'brand.extract_judge',
  'brand.extract_accept',
  'brand.extract_session_get',
  'brand.corpus_list',
  'brand.corpus_get',
  'brand.selection_matches',
  'brand.visual_set_create',
  'brand.visual_set_activate',
  'brand.visual_set_get',
  'brand.visual_set_list',
  'brand.visual_set_update',
] as const

/**
 * The company's brand as executable context (phase-2c + phase-2d). Guideline
 * mutation is human-admin-only (G8/D5); the approval gates on brand.set_activate
 * and brand.visual_set_activate are wired in modules/index.ts
 * APPROVAL_REQUIRED_TOOLS. The extraction judge loop (phase-2d) is
 * human-admin-only too; staging is not publishing. The selection wizard
 * (phase-2d M4) is pure math over the static corpus; activation (M5/V9) is the
 * approval-gated go-live that applies the visual set globally.
 */
export const brandManifest: ModuleManifest = {
  id: 'brand',
  name: 'Brand',
  version: '0.5.0',
  description:
    'Brand kernel: versioned guideline sets (voice exemplars, lexicon, criteria, visual tokens, glossary) with exemplar-first activation guards, the phase-2d design-system extraction judge loop (capture -> propose -> judge -> stage), the phase-2d selection wizard (cluster grid -> centroid matches -> draft visual set), the phase-2d approval-gated go-live (visual_set_activate applies the active set globally), and the phase-2d visual editor (seed re-expansion + owner pins, draft-only).',
  tools: [...BRAND_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
