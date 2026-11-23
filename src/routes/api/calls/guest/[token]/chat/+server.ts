import type { RequestHandler } from './$types'
import { chatSinceOf, readJson } from '../../../../../../../modules/calls/http'
import { guestRoute } from '../../../calls-route'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../../modules/index')).liveCallsService(),
}

/** Public: the call's chat as the guest reads it (`?since=<seq>`), while their link works and once they joined. */
export const GET: RequestHandler = ({ params, url }) =>
  guestRoute("Reading a call's chat from a guest link", _deps.service, async (s) =>
    s.guestChat(params.token, chatSinceOf(url)),
  )

/** Public: the guest writes a line (`{ body }`) as their guest name — only while they are in the room. */
export const POST: RequestHandler = ({ params, request }) =>
  guestRoute("Writing in a call's chat from a guest link", _deps.service, async (s) => {
    const { body } = await readJson(request)
    return { message: await s.guestPostChat(params.token, body) }
  })
