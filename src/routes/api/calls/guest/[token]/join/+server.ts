import type { RequestHandler } from './$types'
import { guestRoute, readJson } from '../../../../../../../modules/calls/http'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../../modules/index')).liveCallsService(),
}

/**
 * Public (no session; the link token is the proof): a guest joins with a
 * display name ({ name }) and gets a LiveKit token for this one room with
 * guest grants — only inside the link's window.
 */
export const POST: RequestHandler = ({ params, request }) =>
  guestRoute(_deps.service, async (s) => s.guestJoin(params.token, (await readJson(request)).name))
