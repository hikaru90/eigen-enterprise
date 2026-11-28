import type { CallsService } from '../../../../modules/calls/service'
import { json } from '@sveltejs/kit'
import { errorReport, refusalReport } from '$lib/server/errors/report'
import { CallsError } from '../../../../modules/calls/errors'
import { callsErrorStatus } from '../../../../modules/calls/http'

/**
 * The /api/calls/* handlers' wrapper: signed-in only, the live service, and
 * every refusal in the one error shape (`{ error, agent }`, plus `code` for a
 * CallsError — the client decides by the code, never by the wording). The
 * sentence is the CallsError's (or the failure's) own message, as before;
 * `attempted` says in words what the route was doing. Anything that is not a
 * CallsError is a logged 500.
 */

const sentence = (err: unknown) => (err instanceof Error ? err.message : String(err))

function failure(err: unknown, attempted: string, headers?: Record<string, string>): Response {
  const report = errorReport(err, { attempted, plain: sentence })
  if (err instanceof CallsError) {
    return json({ ...report, code: err.code }, { status: callsErrorStatus(err), headers })
  }
  return json(report, { status: 500, headers })
}

/** 401 for a signed-out request to a member route. */
export function signInFirst(attempted: string): Response {
  return json(refusalReport('sign in first', { attempted }), { status: 401 })
}

export async function callsRoute(
  attempted: string,
  user: { id: string } | null | undefined,
  service: () => Promise<CallsService>,
  run: (userId: string, service: CallsService) => Promise<unknown>,
): Promise<Response> {
  if (!user) return signInFirst(attempted)
  try {
    const out = await run(user.id, await service())
    return out instanceof Response ? out : json(out ?? { ok: true })
  } catch (err) {
    if (!(err instanceof CallsError)) console.error('[calls] request failed', err)
    return failure(err, attempted)
  }
}

/**
 * The public guest routes (/api/calls/guest/[token]/*): no session — the
 * unguessable link token is the proof, checked by the service. Same error
 * shape; never cached.
 */
export async function guestRoute(
  attempted: string,
  service: () => Promise<CallsService>,
  run: (service: CallsService) => Promise<unknown>,
): Promise<Response> {
  const headers = { 'cache-control': 'no-store' }
  try {
    const out = await run(await service())
    return out instanceof Response ? out : json(out, { headers })
  } catch (err) {
    if (!(err instanceof CallsError)) console.error('[calls] guest request failed', err)
    return failure(err, attempted, headers)
  }
}
