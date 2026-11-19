import type { PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'

/**
 * /calls/[id]/transcript: a call's transcript, merged by time — for people
 * who were in the call (the Calls service decides: a call I may not see is
 * "not found"; one I may see but never joined is refused).
 */
export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user) throw redirect(302, '/login')
  const { liveCallsService } = await import('../../../../../../modules/index')
  const { CallsError } = await import('../../../../../../modules/calls/index')
  try {
    return { me: locals.user.id, ...(await (await liveCallsService()).transcript(locals.user.id, params.id)) }
  } catch (err) {
    if (err instanceof CallsError && err.code === 'not_found') throw error(404, 'Call not found')
    if (err instanceof CallsError && err.code === 'forbidden') throw error(403, err.message)
    throw err
  }
}
