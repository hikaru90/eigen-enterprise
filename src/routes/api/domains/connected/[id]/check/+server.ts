import type { RequestHandler } from './$types'
import { liveConnectRoutes } from '$lib/server/domains/live'

/** Re-checks a connected domain's DNS records now. */
export const POST: RequestHandler = (event) => liveConnectRoutes().check(event, event.params.id)
