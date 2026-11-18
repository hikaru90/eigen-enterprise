import type { RequestHandler } from './$types'
import { liveDomainsRoutes } from '$lib/server/domains/live'

/** Available names with their yearly price in EUR (?q=<one label>). */
export const GET: RequestHandler = (event) => liveDomainsRoutes().search(event)
