import type { RequestHandler } from './$types'
import { callsRoute, readJson } from '../../../../../../modules/calls/http'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../modules/index')).liveCallsService(),
}

/** POST `{ on }`: turn the transcription of my own microphone on or off; everyone in the call sees it. */
export const POST: RequestHandler = ({ locals, params, request }) =>
  callsRoute(locals.user, _deps.service, async (userId, s) => {
    const { on } = await readJson(request)
    return { call: await s.setTranscription(userId, params.id, on as boolean) }
  })
