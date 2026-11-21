import type { RequestHandler } from './$types'
import { error, json } from '@sveltejs/kit'
import type { ErrorReport } from '$lib/errors/agent-report'
import { errorReport, refusalReport } from '$lib/server/errors/report'
import { sendTestNotification } from '$lib/server/push/test-notification'

const ATTEMPTED = 'Sending a test notification (POST /api/push/test)'
/** The one error shape on SvelteKit's error body: `message` is the sentence, `agent` the report. */
function fail(status: number, r: ErrorReport): never {
  error(status, { message: r.error, agent: r.agent })
}
function refuse(status: number, sentence: string, input?: unknown): never {
  fail(status, refusalReport(sentence, { attempted: ATTEMPTED, input }))
}

/**
 * A test notification to the signed-in person's devices — all of them, or
 * the one named by `{ deviceId }` (Settings → Account → Notifications). Same
 * effect as the registry tool notifications.test.
 */
export const POST: RequestHandler = async (event) => {
  const user = event.locals.user
  if (!user) refuse(401, 'Unauthorized')

  const raw = await event.request.text()
  let deviceId: string | undefined
  if (raw.trim()) {
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      refuse(400, 'Expected JSON body')
    }
    const d =
      body && typeof body === 'object' ? (body as { deviceId?: unknown }).deviceId : undefined
    if (d !== undefined && typeof d !== 'string')
      refuse(400, 'deviceId must be a string', { deviceId: d })
    deviceId = d
  }

  try {
    const result = await sendTestNotification(user.id, deviceId)
    return json({ ok: true as const, ...result })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const report = errorReport(e, { attempted: ATTEMPTED, input: { deviceId }, plain: () => msg })
    if (msg.includes('VAPID')) fail(503, report)
    if (msg.startsWith('No push subscription')) fail(400, report)
    fail(500, report)
  }
}
