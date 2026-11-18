import type { RequestHandler } from './$types'
import { liveDomainsRoutes } from '$lib/server/domains/live'

/** Buys a domain: { name, acceptedPriceCents, registrant } → 202 { name, state }. */
export const POST: RequestHandler = (event) => liveDomainsRoutes().purchase(event)
