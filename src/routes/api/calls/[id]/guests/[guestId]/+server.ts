import type { RequestHandler } from './$types'
import { callsRoute } from '../../../calls-route'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../../modules/index')).liveCallsService(),
}

/** The host withdraws a guest's link; a guest in the call is removed from it. */
export const DELETE: RequestHandler = ({ locals, params }) =>
  callsRoute("Withdrawing a guest's link", locals.user, _deps.service, async (userId, s) => ({
    call: await s.revokeGuest(userId, params.id, params.guestId),
  }))
