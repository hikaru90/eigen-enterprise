import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { livekitConfig } from '../../../../../modules/calls/livekit'
import { handleLiveKitWebhook } from '../../../../../modules/calls/webhook'

/**
 * POST /api/calls/livekit — LiveKit's webhook (participant joined/left, room
 * finished), posted by the company's livekit-server through ee's loopback
 * listener. No session and no Origin: exempt from the cross-site form check
 * in $lib/server/csrf; instead nothing is read before the signature (a JWT
 * over the body's sha256, signed with LIVEKIT_API_SECRET) verifies — a bad or
 * missing one is a 401 and changes nothing.
 */

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../../modules/index')).liveCallsService(),
  config: () => livekitConfig(process.env),
}

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.text()
  const out = await handleLiveKitWebhook(await _deps.service(), _deps.config, body, request.headers.get('authorization'))
  return json(out.body, { status: out.status })
}
