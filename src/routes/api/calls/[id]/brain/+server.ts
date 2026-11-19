import type { RequestHandler } from './$types'
import { callsRoute, readJson } from '../../../../../../modules/calls/http'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../modules/index')).liveCallsService(),
}

/** GET: my own Company Brain answers in this call (private to me). */
export const GET: RequestHandler = ({ locals, params }) =>
  callsRoute(locals.user, _deps.service, async (userId, s) => ({ answers: await s.myBrainAnswers(userId, params.id) }))

/** POST `{ on }`: switch the Company Brain on (a member in the call) or off (anyone in it); everyone in the call sees it. */
export const POST: RequestHandler = ({ locals, params, request }) =>
  callsRoute(locals.user, _deps.service, async (userId, s) => {
    const { on } = await readJson(request)
    return { call: await s.setBrain(userId, params.id, on as boolean) }
  })
