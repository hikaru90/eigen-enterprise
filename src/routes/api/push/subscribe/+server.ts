import type { RequestHandler } from './$types'
import { error, json } from '@sveltejs/kit'
import type { ErrorReport } from '$lib/errors/agent-report'
import { errorReport, refusalReport } from '$lib/server/errors/report'
import { parseReplacedEndpoint } from '$lib/server/push/device'
import {
  deletePushSubscriptionByEndpoint,
  parsePushSubscriptionBody,
  PUSH_SUBSCRIBE_USER_ERROR,
  upsertPushSubscription,
} from '$lib/server/push/subscription'

const ATTEMPTED = 'Turning on notifications on this device (POST /api/push/subscribe)'
/** The one error shape on SvelteKit's error body: `message` is the sentence, `agent` the report. */
function fail(status: number, r: ErrorReport): never {
  error(status, { message: r.error, agent: r.agent })
}

export const POST: RequestHandler = async (event) => {
  const user = event.locals.user
  if (!user) fail(401, refusalReport('Unauthorized', { attempted: ATTEMPTED }))

  let body: unknown
  try {
    body = await event.request.json()
  } catch {
    fail(400, refusalReport('Expected JSON body', { attempted: ATTEMPTED }))
  }

  let input
  let replaces: string | null
  try {
    input = parsePushSubscriptionBody(body)
    replaces = parseReplacedEndpoint(body, input.endpoint)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    fail(400, errorReport(e, { attempted: ATTEMPTED, plain: () => msg }))
  }

  const userAgent = event.request.headers.get('user-agent')

  try {
    const row = await upsertPushSubscription(user.id, input, userAgent)
    // The service worker renewed this device's subscription: the old endpoint is dead (RLS: only this person's row).
    if (replaces) await deletePushSubscriptionByEndpoint(replaces)
    return json({ ok: true as const, id: row.id })
  } catch (e) {
    console.error('[push/subscribe] persist failed', {
      userId: user.id,
      message: e instanceof Error ? e.message : String(e),
    })
    fail(500, errorReport(e, { attempted: ATTEMPTED, plain: () => PUSH_SUBSCRIBE_USER_ERROR }))
  }
}
