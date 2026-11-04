import type { RequestHandler } from './$types'
import { messagesRoute } from '../../../../../../../modules/messages/http'
import { conversationMembers } from '../../../../../../../modules/messages/service'

/** Who is in the conversation (the header's member count and avatars). */
export const GET: RequestHandler = ({ locals, params }) =>
  messagesRoute(locals.user, async (userId, d) => ({ members: await conversationMembers(d, userId, params.id) }))
