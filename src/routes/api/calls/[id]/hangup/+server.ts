import type { RequestHandler } from './$types'
import { callsRoute } from '../../../../../../modules/calls/http'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../modules/index')).liveCallsService(),
}

/** Leave the call (the caller hanging up a call that is still ringing cancels it: missed). */
export const POST: RequestHandler = ({ locals, params }) =>
  callsRoute(locals.user, _deps.service, async (userId, s) => ({ call: await s.hangup(userId, params.id) }))
