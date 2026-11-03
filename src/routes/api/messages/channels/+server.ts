import type { RequestHandler } from './$types'
import { messagesRoute, readJson, stringList } from '../../../../../modules/messages/http'
import { createChannel, MessagesError } from '../../../../../modules/messages/service'

/** New channel: { name, topic?, private, userIds?, groupIds? }. */
export const POST: RequestHandler = ({ locals, request }) =>
  messagesRoute(locals.user, async (userId, d) => {
    const b = await readJson(request)
    if (typeof b.name !== 'string') throw new MessagesError('invalid', 'name is required')
    if (typeof b.private !== 'boolean') throw new MessagesError('invalid', 'private must be true or false')
    const conversation = await createChannel(d, userId, {
      name: b.name,
      topic: typeof b.topic === 'string' ? b.topic : '',
      private: b.private,
      userIds: stringList(b.userIds, 'userIds'),
      groupIds: stringList(b.groupIds, 'groupIds'),
    })
    return { conversation }
  })
