import type { RequestHandler } from './$types'
import { messagesRoute } from '../../../../../../modules/messages/http'
import { presenceStreamResponse } from '../../../../../../modules/messages/hub'
import { presenceStreamFor } from '../../../../../../modules/messages/presence'
import { MessagesError } from '../../../../../../modules/messages/service'

/**
 * Everyone's status and where they are working, live (SSE,
 * plan/phase-multiplayer-presence.md) — the feed every page's shell opens.
 * `event: presence` frames { people, replace }: the whole company on connect,
 * then changes; each person's where filtered for this viewer. Company members
 * only (403 otherwise); the CLI's read is messages.presence.
 */
export const GET: RequestHandler = ({ locals, request }) =>
  messagesRoute(locals.user, 'Opening the live presence feed (/api/messages)', async (userId, d) => {
    const [{ presence }, { liveCoworkerPresence }, { liveWhereDrive }] = await Promise.all([
      import('$lib/server/presence'),
      import('$lib/server/coworkers/presence'),
      import('../../../../../../modules/messages/live'),
    ])
    const feed = await presenceStreamFor(d, presence, userId, await liveCoworkerPresence(), await liveWhereDrive())
    if (!feed) throw new MessagesError('forbidden', 'only members of the company see presence')
    return presenceStreamResponse(feed, userId, request.signal)
  })
