import type { RequestHandler } from './$types'
import { messagesRoute, readJson } from '../../../../../modules/messages/http'
import { MessagesError, setViewing } from '../../../../../modules/messages/service'

/** Heartbeat { conversationId | null }: suppresses push while the person is looking at it. */
export const POST: RequestHandler = ({ locals, request }) =>
  messagesRoute(locals.user, async (userId, d) => {
    const b = await readJson(request)
    const id = b.conversationId
    if (id !== null && typeof id !== 'string') throw new MessagesError('invalid', 'conversationId must be an id or null')
    await setViewing(d, userId, id)
  })
