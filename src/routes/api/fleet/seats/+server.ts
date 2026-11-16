import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { seatsHandler } from '$lib/server/fleet/seats'
import { countSeats } from '$lib/server/fleet/seat-count'

/** Loopback only in practice: ee calls it on OS_INTERNAL_PORT with the per-box token (managed mode). */
export const GET: RequestHandler = ({ request }) => seatsHandler({ token: env.EE_FLEET_LOCAL_TOKEN, count: countSeats })(request)
