import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { callsStreamResponse } from '../../../../../modules/calls/hub'

/** Overridable in tests. */
export const _deps = {
  hub: async () => (await import('../../../../../modules/index')).liveCallsHub(),
}

/**
 * The signed-in person's live call feed (SSE): `call.ringing` when a call
 * rings for them, `call.state` for every change of a call they are part of.
 * Opens with a snapshot of their ringing/active calls (no event log to resume).
 */
export const GET: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) return json({ error: 'sign in first' }, { status: 401 })
  return callsStreamResponse(await _deps.hub(), locals.user.id, request.signal)
}
