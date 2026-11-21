import type { RequestHandler } from './$types'
import { error, json } from '@sveltejs/kit'
import { errorReport, refusalReport } from '$lib/server/errors/report'
import { readVapidConfigFromEnv } from '$lib/server/push/vapid'

const ATTEMPTED = 'Reading the push key to turn on notifications (GET /api/push/vapid-public-key)'

export const GET: RequestHandler = async (event) => {
  if (!event.locals.user) {
    const r = refusalReport('Unauthorized', { attempted: ATTEMPTED })
    error(401, { message: r.error, agent: r.agent })
  }
  try {
    const { publicKey } = readVapidConfigFromEnv()
    return json({ publicKey })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const r = errorReport(e, {
      attempted: ATTEMPTED,
      plain: () => msg,
      nextSteps: [
        'Push needs VAPID keys on this server: the owner sets VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in the environment (never a default).',
      ],
    })
    error(503, { message: r.error, agent: r.agent })
  }
}
