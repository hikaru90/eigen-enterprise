import type { RequestHandler } from './$types'
import { messagesRoute, readJson } from '../../../../../../../modules/messages/http'
import { MessagesError, renameConversation } from '../../../../../../../modules/messages/service'

/** Name a group chat { name } (empty clears it): any of its members (messages.rename_conversation). */
export const PUT: RequestHandler = ({ locals, params, request }) =>
  messagesRoute(locals.user, 'Naming a group chat (/api/messages)', async (userId, d) => {
    const b = await readJson(request)
    if (typeof b.name !== 'string') throw new MessagesError('invalid', 'name is required (empty clears it)')
    return { conversation: await renameConversation(d, userId, params.id, b.name) }
  })
