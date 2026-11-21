import type { RequestHandler } from './$types'
import { messagesRoute, readJson } from '../../../../../../../modules/messages/http'
import { MessagesError, toggleReaction } from '../../../../../../../modules/messages/service'

/** Toggle the signed-in person's reaction { emoji } (any single emoji); returns the message. */
export const POST: RequestHandler = ({ locals, params, request }) =>
  messagesRoute(locals.user, 'Reacting to a message (/api/messages)', async (userId, d) => {
    const b = await readJson(request)
    if (typeof b.emoji !== 'string') throw new MessagesError('invalid', 'emoji is required')
    return { message: await toggleReaction(d, userId, params.id, b.emoji) }
  })
