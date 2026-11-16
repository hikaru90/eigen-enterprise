import { timingSafeEqual } from 'node:crypto'

/**
 * Billing seats for a managed box (plan/phase-managed-box.md M4, D6): ee asks
 * os on loopback with the per-box EE_FLEET_LOCAL_TOKEN it injected. A box that
 * was never enrolled has no token and answers 404.
 */
export function seatsHandler(deps: { token: string | undefined; count: () => Promise<number> }): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!deps.token) return new Response('not found', { status: 404 })
    const auth = request.headers.get('authorization') ?? ''
    const given = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7) : '')
    const want = Buffer.from(deps.token)
    if (given.length !== want.length || !timingSafeEqual(given, want)) return new Response('unauthorized', { status: 401 })
    return Response.json({ seats: await deps.count() })
  }
}
