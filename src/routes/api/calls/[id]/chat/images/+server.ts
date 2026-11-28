import type { RequestHandler } from './$types'
import { chatImageUploadOf } from '../../../../../../../modules/calls/http'
import { callsRoute } from '../../../calls-route'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../../modules/index')).liveCallsService(),
}

/** POST multipart `file`: I paste an image in the chat of the live call I am in (calls.chat_post_image). */
export const POST: RequestHandler = ({ locals, params, request }) =>
  callsRoute(
    'Pasting an image in the chat of a call',
    locals.user,
    _deps.service,
    async (userId, s) => ({
      message: await s.postChatImage(userId, params.id, await chatImageUploadOf(request)),
    }),
  )
