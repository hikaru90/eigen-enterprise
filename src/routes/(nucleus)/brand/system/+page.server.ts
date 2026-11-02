import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { defaultBrandStore } from '../../../../../modules/brand/store'

/**
 * /brand/system (B4): the design-system view of the ACTIVE visual set.
 * Any signed-in member may view it (read-only). No active set is a legit
 * state — the page shows its "choose a style first" empty state; any store
 * failure propagates loud.
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, '/login')
  const active = await defaultBrandStore().findActiveVisualSet()
  return {
    style: active
      ? {
          id: active.id,
          name: active.name,
          cssVars: active.cssVars,
          darkCssVars: active.darkCssVars,
        }
      : null,
  }
}
