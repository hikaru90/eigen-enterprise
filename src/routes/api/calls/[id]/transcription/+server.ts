import type { RequestHandler } from './$types'
import { readJson } from '../../../../../../modules/calls/http'
import { callsRoute } from '../../calls-route'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../modules/index')).liveCallsService(),
}

/** POST `{ on }`: turn the transcription of my own microphone on or off; everyone in the call sees it. */
export const POST: RequestHandler = ({ locals, params, request }) =>
  callsRoute(
    'Turning my call transcription on or off',
    locals.user,
    _deps.service,
    async (userId, s) => {
      const { on } = await readJson(request)
      return { call: await s.setTranscription(userId, params.id, on as boolean) }
    },
  )
