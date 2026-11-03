import type { RequestHandler } from './$types'
import { messagesRoute } from '../../../../../../../modules/messages/http'
import { listThread } from '../../../../../../../modules/messages/service'

/** A thread: { parent, replies } (oldest first). */
export const GET: RequestHandler = ({ locals, params }) =>
  messagesRoute(locals.user, (userId, d) => listThread(d, userId, params.id))
