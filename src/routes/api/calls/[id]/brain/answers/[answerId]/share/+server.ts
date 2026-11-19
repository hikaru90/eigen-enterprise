import type { RequestHandler } from './$types'
import { callsRoute } from '../../../../../../../../../modules/calls/http'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../../../../modules/index')).liveCallsService(),
}

/** POST: share my Company Brain answer with the colleagues in the call (from the Brain, asked by me). */
export const POST: RequestHandler = ({ locals, params }) =>
  callsRoute(locals.user, _deps.service, async (userId, s) => ({ call: await s.shareBrainAnswer(userId, params.id, params.answerId) }))
