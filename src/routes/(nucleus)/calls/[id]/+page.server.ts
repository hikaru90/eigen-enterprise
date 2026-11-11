import type { PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'

/**
 * /calls/[id]: the call page. The call as I may see it (membership checked by
 * the Calls service; a call I may not see is "not found"). Joining — accept,
 * token, room — happens in the browser.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user) throw redirect(302, '/login')
  const { liveCallsService } = await import('../../../../../modules/index')
  const { CallsError } = await import('../../../../../modules/calls/index')
  try {
    return { me: locals.user.id, call: await (await liveCallsService()).get(locals.user.id, params.id) }
  } catch (err) {
    if (err instanceof CallsError && err.code === 'not_found') throw error(404, 'Call not found')
    throw err
  }
}
