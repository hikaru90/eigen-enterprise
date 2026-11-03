import type { RequestHandler } from './$types'
import { messagesRoute, readJson, stringList } from '../../../../../modules/messages/http'
import { openDm } from '../../../../../modules/messages/service'

/** Open (or find) the DM with exactly these people: { userIds }. */
export const POST: RequestHandler = ({ locals, request }) =>
  messagesRoute(locals.user, async (userId, d) => {
    const b = await readJson(request)
    return { conversation: await openDm(d, userId, stringList(b.userIds, 'userIds')) }
  })
