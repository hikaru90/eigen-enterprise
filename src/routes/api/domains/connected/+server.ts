import type { RequestHandler } from './$types'
import { liveConnectRoutes } from '$lib/server/domains/live'

/** "I already have one": { name } → the mail domain with its DNS records. */
export const POST: RequestHandler = (event) => liveConnectRoutes().add(event)
