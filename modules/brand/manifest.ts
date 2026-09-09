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
  'brand.visual_set_get',
  'brand.visual_set_list',
] as const

/**
 * The company's brand as executable context (phase-2c + phase-2d). Guideline
 * mutation is human-admin-only (G8/D5); the approval gate on brand.set_activate
 * is wired in modules/index.ts APPROVAL_REQUIRED_TOOLS. The extraction judge
 * loop (phase-2d) is human-admin-only too; staging is not publishing. The
 * selection wizard (phase-2d M4) is pure math over the static corpus; only
 * visual_set_create mutates (human-admin, draft-only — activation is M5).
 */
export const brandManifest: ModuleManifest = {
  id: 'brand',
  name: 'Brand',
  version: '0.3.0',
  description:
    'Brand kernel: versioned guideline sets (voice exemplars, lexicon, criteria, visual tokens, glossary) with exemplar-first activation guards, the phase-2d design-system extraction judge loop (capture -> propose -> judge -> stage), and the phase-2d selection wizard (cluster grid -> centroid matches -> draft visual set).',
  tools: [...BRAND_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
