import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'

/**
 * The Apps overview moved to the module's front page (/m/website) — apps are
 * the point of the Website module (D-W7), so they land there directly. This
 * route stays as a redirect for every link and bookmark that predates the move.
 */
export const load: PageServerLoad = async () => {
  redirect(303, '/m/website')
}
