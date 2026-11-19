import type { RequestHandler } from './$types'
import { callsRoute, readJson } from '../../../../../../../modules/calls/http'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../../modules/index')).liveCallsService(),
}

/** POST `{ question }`: ask the listening Company Brain; the answer is mine alone (run as me) until I share it. */
export const POST: RequestHandler = ({ locals, params, request }) =>
  callsRoute(locals.user, _deps.service, async (userId, s) => {
    const { question } = await readJson(request)
    return { answer: await s.askBrain(userId, params.id, question) }
  })
