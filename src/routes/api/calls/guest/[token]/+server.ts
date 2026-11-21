import type { RequestHandler } from './$types'
import { guestRoute } from '../../calls-route'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../modules/index')).liveCallsService(),
}

/**
 * Public (no session): a guest's own view of the call behind their link —
 * nobody's email. A revoked or unknown link: 403 / 404.
 */
export const GET: RequestHandler = ({ params }) =>
  guestRoute("Loading a guest's call from their link", _deps.service, async (s) => ({
    call: await s.guestCall(params.token),
  }))
