import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { liveFleetAiUsage } from '$lib/server/ai-usage/store'
import { aiUsageHandler } from '$lib/server/fleet/ai-usage'

/** Loopback only in practice: ee calls it on OS_INTERNAL_PORT with the per-box token (managed mode). */
export const GET: RequestHandler = ({ request }) =>
  aiUsageHandler({ token: env.EE_FLEET_LOCAL_TOKEN, today: () => new Date().toISOString().slice(0, 10), read: liveFleetAiUsage })(request)
