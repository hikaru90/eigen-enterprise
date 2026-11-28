import type { RequestHandler } from './$types'
import { chatImageUploadOf } from '../../../../../../../../modules/calls/http'
import { guestRoute } from '../../../../calls-route'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../../../modules/index')).liveCallsService(),
}

/** Public: the guest pastes an image (multipart `file`) — only while they are in the room. */
export const POST: RequestHandler = ({ params, request }) =>
  guestRoute("Pasting an image in a call's chat from a guest link", _deps.service, async (s) => ({
    message: await s.guestPostChatImage(params.token, await chatImageUploadOf(request)),
  }))
