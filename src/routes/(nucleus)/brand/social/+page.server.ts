import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { defaultSocialPostStore } from '../../../../../modules/brand/social/store'
import { defaultBrandStore } from '../../../../../modules/brand/store'

/**
 * /brand/social: the company's social posts (Contribute 6ff283ef). Any
 * signed-in member works on them. Graphics are drawn from the ACTIVE visual
 * set (none is a legit state: the tab says so); the active brand voices'
 * locales pick the caption language when there are several. ?post= opens one
 * (the assistant's tools link there). Store failures propagate loud.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) throw redirect(302, '/login')
  const brand = defaultBrandStore()
  const [active, voices, posts] = await Promise.all([
    brand.findActiveVisualSet(),
    brand.listSets({ status: 'active' }),
    defaultSocialPostStore().list(),
  ])
  return {
    style: active ? { id: active.id, name: active.name, cssVars: active.cssVars, darkCssVars: active.darkCssVars } : null,
    activeLocales: voices.map((v) => v.locale).sort(),
    posts,
    selected: url.searchParams.get('post'),
  }
}
