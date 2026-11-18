import type { RequestHandler } from './$types'
import { callsRoute, readJson, scheduleInputOf } from '../../../../../modules/calls/http'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../modules/index')).liveCallsService(),
}

/**
 * The New call dialog (proposal 844bab56): a meeting with guests by email
 * and/or colleagues, now or booked, with a duration — or on another
 * provider's link. Returns the call, every guest's personal link (once, to
 * copy) and whether company email is set up.
 */
export const POST: RequestHandler = ({ locals, request }) =>
  callsRoute(locals.user, _deps.service, async (userId, s) => {
    const out = await s.schedule({ kind: 'user', userId }, scheduleInputOf(await readJson(request)))
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  })
