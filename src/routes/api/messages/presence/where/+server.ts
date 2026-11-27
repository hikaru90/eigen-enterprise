import type { RequestHandler } from './$types'
import { messagesRoute, readJson } from '../../../../../../modules/messages/http'
import { setShareWhere } from '../../../../../../modules/messages/presence'

/**
 * { shareWhere: boolean } — the person's own "Share where I am" switch
 * (plan/phase-multiplayer-presence.md; the CLI's is messages.set_share_where).
 * Stored, then the live presence follows; answers their presence.
 */
export const PUT: RequestHandler = ({ locals, request }) =>
  messagesRoute(locals.user, 'Switching Share where I am (/api/messages)', async (userId, d) => {
    const { presence, shareWhereStore } = await import('$lib/server/presence')
    return { presence: await setShareWhere(d, await presence(), await shareWhereStore(), userId, await readJson(request)) }
  })
