import type { RequestHandler } from './$types'
import { chatImageResponse } from '../../../../../../../../modules/calls/http'
import { callsRoute } from '../../../../calls-route'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../../../modules/index')).liveCallsService(),
}

/** GET: an image of the call's chat, for whoever reads that chat (calls.chat_image). */
export const GET: RequestHandler = ({ locals, params }) =>
  callsRoute('Opening an image of a call chat', locals.user, _deps.service, async (userId, s) =>
    chatImageResponse(await s.chatImage(userId, params.id, params.imageId)),
  )
