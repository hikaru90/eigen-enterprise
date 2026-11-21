import type { RequestHandler } from './$types'
import { callsRoute, signInFirst } from '../../calls-route'
import { readTranscriptChunk } from '../../transcript-chunk'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../modules/index')).liveCallsService(),
}

/**
 * POST: one ~30 s chunk of my own microphone (raw audio body +
 * x-chunk-duration-ms) → `{ segment }` of the call's transcript (null: no
 * speech). Only while I am in the live call with my transcription on. The
 * audio is transcribed once and dropped. 503 `unavailable`: this server has
 * no speech to text.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return signInFirst('Transcribing a chunk of my microphone in a call')
  const chunk = await readTranscriptChunk(request)
  return callsRoute(
    'Transcribing a chunk of my microphone in a call',
    locals.user,
    _deps.service,
    (userId, s) => s.transcribeChunk(userId, params.id, chunk),
  )
}

/** GET: the call's transcript merged by time — for people who were in the call. */
export const GET: RequestHandler = ({ locals, params }) =>
  callsRoute("Loading a call's transcript", locals.user, _deps.service, async (userId, s) => {
    const out = await s.transcript(userId, params.id)
    return new Response(JSON.stringify(out), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  })
