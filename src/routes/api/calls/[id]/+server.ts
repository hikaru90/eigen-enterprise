import type { RequestHandler } from './$types'
import { callsRoute } from '../../../../../modules/calls/http'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../modules/index')).liveCallsService(),
}

/** One call, as the signed-in person may see it. */
export const GET: RequestHandler = ({ locals, params }) =>
  callsRoute(locals.user, _deps.service, async (userId, s) => ({ call: await s.get(userId, params.id) }))
