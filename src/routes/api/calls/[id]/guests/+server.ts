import type { RequestHandler } from './$types'
import { readJson } from '../../../../../../modules/calls/http'
import { callsRoute } from '../../calls-route'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../modules/index')).liveCallsService(),
}

/** The host invites more guests ({ guests: [emails], timeZone }): new links, once, to copy. */
export const POST: RequestHandler = ({ locals, params, request }) =>
  callsRoute('Inviting guests to a call', locals.user, _deps.service, async (userId, s) => {
    const body = await readJson(request)
    const out = await s.inviteGuests(userId, params.id, {
      guests: body.guests,
      timeZone: body.timeZone,
    })
    return new Response(JSON.stringify(out), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  })
