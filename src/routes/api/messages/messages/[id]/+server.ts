import type { RequestHandler } from './$types'
import { messagesRoute, readJson } from '../../../../../../modules/messages/http'
import { deleteMessage, editMessage, MessagesError } from '../../../../../../modules/messages/service'

/** Edit own message { body }. */
export const PATCH: RequestHandler = ({ locals, params, request }) =>
  messagesRoute(locals.user, async (userId, d) => {
    const b = await readJson(request)
    if (typeof b.body !== 'string') throw new MessagesError('invalid', 'body is required')
    await editMessage(d, userId, params.id, b.body)
  })

/** Delete own message; owner/admin may delete any message in a channel (moderation, audited). */
export const DELETE: RequestHandler = ({ locals, params }) =>
  messagesRoute(locals.user, (userId, d) => deleteMessage(d, userId, params.id))
