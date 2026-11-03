import type { RequestHandler } from './$types'
import { messagesRoute } from '../../../../../modules/messages/http'
import { listConversations } from '../../../../../modules/messages/service'

/** The conversations the signed-in person may see, with unread counts. */
export const GET: RequestHandler = ({ locals }) =>
  messagesRoute(locals.user, async (userId, d) => ({ conversations: await listConversations(d, userId) }))
