import type { RequestHandler } from './$types'
import { guestRoute } from '../../../../../../../modules/calls/http'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../../modules/index')).liveCallsService(),
}

/** Public: the guest's hang-up button (keepalive on tab close). The meeting stays open for the others. */
export const POST: RequestHandler = ({ params }) => guestRoute(_deps.service, async (s) => ({ call: await s.guestLeave(params.token) }))
