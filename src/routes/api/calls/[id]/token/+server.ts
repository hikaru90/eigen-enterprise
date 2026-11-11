import type { RequestHandler } from './$types'
import { callsRoute } from '../../../../../../modules/calls/http'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../modules/index')).liveCallsService(),
}

/**
 * A LiveKit join token for this call's room (identity = the signed-in person,
 * ~10 minutes) and the wss:// URL to connect to. Only for people who accepted.
 */
export const GET: RequestHandler = ({ locals, params }) =>
  callsRoute(locals.user, _deps.service, async (userId, s) => {
    const token = await s.token(userId, params.id)
    return new Response(JSON.stringify(token), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  })
