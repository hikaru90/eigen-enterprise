import type { RequestHandler } from './$types'
import { liveManagedSender } from '$lib/server/domains/live'

/** The Email act on a managed box: { address } becomes the default sender. */
export const POST: RequestHandler = (event) => liveManagedSender()(event)
