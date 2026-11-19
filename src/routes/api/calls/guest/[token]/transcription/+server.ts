import type { RequestHandler } from './$types'
import { guestRoute, readJson } from '../../../../../../../modules/calls/http'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../../modules/index')).liveCallsService(),
}

/** Public: the guest turns the transcription of their own microphone on or off (`{ on }`). */
export const POST: RequestHandler = ({ params, request }) =>
  guestRoute(_deps.service, async (s) => {
    const { on } = await readJson(request)
    return { call: await s.guestSetTranscription(params.token, on as boolean) }
  })
