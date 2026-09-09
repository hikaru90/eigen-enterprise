import type { PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { defaultBrandStore } from '../../../../modules/brand/store'
import { grayscaleTint } from '../../../../modules/brand/style-format/tint'
import { isPubliclyRenderable } from '../../../../modules/website/render-gate'
import { defaultWebsiteStore } from '../../../../modules/website/store'

/**
 * The hero's look when NO visual set is active: the app's own current style —
 * an explicit in-repo constant (phase-2d V9: absence of a brand is legit, no
 * fallback machinery, values identical to the pre-M5 hardcoded hero).
 */
const HERO_BG = '#060606'
const HERO_FG = '#b9b9b9'
const HERO_H1_COLOR = '#ffffff'

export const load: PageServerLoad = async (event) => {
  const slug = event.params.slug?.trim() ?? ''
  if (!slug) error(404, 'Page not found')

  const page = await defaultWebsiteStore().getPage(slug)
  if (!page || !isPubliclyRenderable(page)) error(404, 'Page not found')

  // Phase-2d M5 (V9): the active visual set drives the public hero; the
  // water-flow shader's monochrome invariant is a brand constant, so chromatic
  // tenant brands project onto the L axis (grayscaleTint) and keep the flow
  // live instead of tripping the static fallback. Null set = the constants
  // above, byte-identical to the pre-brand hero.
  const activeVisualSet = await defaultBrandStore().findActiveVisualSet()
  const heroBg = activeVisualSet?.cssVars['--background'] ?? HERO_BG
  const heroFg = activeVisualSet?.cssVars['--foreground'] ?? HERO_FG
  const h1Color = activeVisualSet?.cssVars['--foreground'] ?? HERO_H1_COLOR

  return {
    title: page.title,
    body: page.body,
    updatedAt: page.updatedAt,
    brand: {
      heroBg,
      heroFg,
      h1Color,
      waterFlowFrom: grayscaleTint(heroBg),
      waterFlowTo: grayscaleTint(heroFg),
    },
  }
}
