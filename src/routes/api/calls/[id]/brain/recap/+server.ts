import type { RequestHandler } from './$types'
import { callsRoute } from '../../../../../../../modules/calls/http'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../../modules/index')).liveCallsService(),
}

/** POST: after the call, a recap of what the Company Brain heard — for whoever switched it on, generated on this request, posted nowhere. */
export const POST: RequestHandler = ({ locals, params }) => callsRoute(locals.user, _deps.service, (userId, s) => s.brainRecap(userId, params.id))
