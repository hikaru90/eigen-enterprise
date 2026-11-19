import type { RequestHandler } from './$types'
import { guestRoute } from '../../../../../../../modules/calls/http'
import { readTranscriptChunk } from '../../../transcript-chunk'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../../../modules/index')).liveCallsService(),
}

/**
 * Public (the link is the proof): one chunk of the guest's own microphone →
 * `{ segment }` of the transcript, spoken by the guest, billed to the host.
 */
export const POST: RequestHandler = async ({ params, request }) => {
  const chunk = await readTranscriptChunk(request)
  return guestRoute(_deps.service, (s) => s.guestTranscribeChunk(params.token, chunk))
}
