import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'

/** /agent is the Agent area's door: its first tab is Runs. */
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, '/login')
  throw redirect(303, '/agent/runs')
}
