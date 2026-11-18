import type { RequestHandler } from './$types'
import { guestRoute } from '../../../../../../modules/calls/http'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../modules/index')).liveCallsService(),
}

/**
 * Public (no session): a guest's own view of the call behind their link —
 * nobody's email. A revoked or unknown link: 403 / 404.
 */
export const GET: RequestHandler = ({ params }) => guestRoute(_deps.service, async (s) => ({ call: await s.guestCall(params.token) }))
