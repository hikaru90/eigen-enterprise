import type { RequestHandler } from './$types'
import { error, json } from '@sveltejs/kit'
import { sendTestNotification } from '$lib/server/push/test-notification'

/**
 * A test notification to the signed-in person's devices — all of them, or
 * the one named by `{ deviceId }` (Settings → Account → Notifications). Same
 * effect as the registry tool notifications.test.
 */
export const POST: RequestHandler = async (event) => {
  const user = event.locals.user
  if (!user) error(401, 'Unauthorized')

  const raw = await event.request.text()
  let deviceId: string | undefined
  if (raw.trim()) {
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      error(400, 'Expected JSON body')
    }
    const d = body && typeof body === 'object' ? (body as { deviceId?: unknown }).deviceId : undefined
    if (d !== undefined && typeof d !== 'string') error(400, 'deviceId must be a string')
    deviceId = d
  }

  try {
    const result = await sendTestNotification(user.id, deviceId)
    return json({ ok: true as const, ...result })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('VAPID')) error(503, msg)
    if (msg.startsWith('No push subscription')) error(400, msg)
    error(500, msg)
  }
}
