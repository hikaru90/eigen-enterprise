import type { RequestHandler } from './$types'
import { liveDomainsRoutes } from '$lib/server/domains/live'

/** The company's bought domains and whether this box can buy (plan/managed-domains.md). */
export const GET: RequestHandler = (event) => liveDomainsRoutes().list(event)
