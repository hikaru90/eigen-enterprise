import type { RequestHandler } from './$types'
import { chatSinceOf, readJson } from '../../../../../../modules/calls/http'
import { callsRoute } from '../../calls-route'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../modules/index')).liveCallsService(),
}

/** GET (`?since=<seq>`): the call's chat in order — for people in the call now or who were in it (calls.chat_read). */
export const GET: RequestHandler = ({ locals, params, url }) =>
  callsRoute('Reading the chat of a call', locals.user, _deps.service, async (userId, s) =>
    s.chat(userId, params.id, chatSinceOf(url)),
  )

/** POST `{ body }`: I write a line in the chat of the live call I am in (calls.chat_post). */
export const POST: RequestHandler = ({ locals, params, request }) =>
  callsRoute('Writing in the chat of a call', locals.user, _deps.service, async (userId, s) => {
    const { body } = await readJson(request)
    return { message: await s.postChat(userId, params.id, body) }
  })
