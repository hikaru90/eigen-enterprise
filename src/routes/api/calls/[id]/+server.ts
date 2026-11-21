import type { RequestHandler } from './$types'
import { callsRoute } from '../calls-route'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../modules/index')).liveCallsService(),
}

/** One call, as the signed-in person may see it. */
export const GET: RequestHandler = ({ locals, params }) =>
  callsRoute('Loading a call', locals.user, _deps.service, async (userId, s) => ({
    call: await s.get(userId, params.id),
  }))
