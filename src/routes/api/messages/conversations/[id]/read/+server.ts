import type { RequestHandler } from './$types'
import { messagesRoute } from '../../../../../../../modules/messages/http'
import { markRead } from '../../../../../../../modules/messages/service'

export const POST: RequestHandler = ({ locals, params }) =>
  messagesRoute(locals.user, (userId, d) => markRead(d, userId, params.id))
