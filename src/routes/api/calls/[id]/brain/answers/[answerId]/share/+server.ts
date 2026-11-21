import type { RequestHandler } from './$types'
import { callsRoute } from '../../../../../calls-route'

/** Overridable in tests. */
export const _deps = {
  service: async () =>
    (await import('../../../../../../../../../modules/index')).liveCallsService(),
}

/** POST: share my Company Brain answer with the colleagues in the call (from the Brain, asked by me). */
export const POST: RequestHandler = ({ locals, params }) =>
  callsRoute(
    'Sharing a Company Brain answer with the call',
    locals.user,
    _deps.service,
    async (userId, s) => ({ call: await s.shareBrainAnswer(userId, params.id, params.answerId) }),
  )
