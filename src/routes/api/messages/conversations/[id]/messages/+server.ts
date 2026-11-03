import type { RequestHandler } from './$types'
import { messagesRoute, readJson } from '../../../../../../../modules/messages/http'
import { listMessages, MessagesError, postMessage } from '../../../../../../../modules/messages/service'

/** History, newest page first in time order; ?before=<messageId> pages back. */
export const GET: RequestHandler = ({ locals, params, url }) =>
  messagesRoute(locals.user, (userId, d) =>
    listMessages(d, userId, params.id, {
      beforeId: url.searchParams.get('before'),
      limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
    }),
  )

/** Post { body } (Markdown). DMs and @mentions push to people not looking at it. */
export const POST: RequestHandler = ({ locals, params, request }) =>
  messagesRoute(locals.user, async (userId, d) => {
    const b = await readJson(request)
    if (typeof b.body !== 'string') throw new MessagesError('invalid', 'body is required')
    const { message, conversation } = await postMessage(d, userId, params.id, b.body)
    const { pushNewMessage } = await import('../../../../../../../modules/messages/live')
    pushNewMessage(d, conversation, message)
    return { message }
  })
