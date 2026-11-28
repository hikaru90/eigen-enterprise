import type { RequestHandler } from './$types'
import { chatImageResponse } from '../../../../../../../../../modules/calls/http'
import { guestRoute } from '../../../../../calls-route'

/** Overridable in tests. */
export const _deps = {
  service: async () =>
    (await import('../../../../../../../../../modules/index')).liveCallsService(),
}

/** Public: an image of the chat, as the guest reads it (while their link works). */
export const GET: RequestHandler = ({ params }) =>
  guestRoute("Opening an image of a call's chat from a guest link", _deps.service, async (s) =>
    chatImageResponse(await s.guestChatImage(params.token, params.imageId)),
  )
