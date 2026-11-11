import type { RequestHandler } from './$types'
import { callsRoute } from '../../../../../../modules/calls/http'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../modules/index')).liveCallsService(),
}

/** Answer the call (then fetch a token to join the room). */
export const POST: RequestHandler = ({ locals, params }) =>
  callsRoute(locals.user, _deps.service, async (userId, s) => ({ call: await s.accept(userId, params.id) }))
