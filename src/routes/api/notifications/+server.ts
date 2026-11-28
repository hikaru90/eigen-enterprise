import type { RequestHandler } from './$types'
import { error, json } from '@sveltejs/kit'
import { KernelError } from '$lib/kernel/errors'
import { personRun, type PersonRunner } from '$lib/server/org/person-run'

/**
 * The top bar's bell (wishes f3fc516e, 3c1481b9): a UI client of the registry —
 * GET is notifications.inbox, POST { keys } is notifications.mark_read, both
 * run as the signed-in person.
 */

/** Overridable in tests. */
export const _deps: { run: PersonRunner } = { run: personRun }

function fail(e: unknown): never {
  if (e instanceof KernelError && e.code === 'invalid_input') error(400, e.message)
  throw e
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) error(401, 'Unauthorized')
  return json(await _deps.run(locals.user, 'notifications.inbox', {}))
}

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) error(401, 'Unauthorized')
  let body: unknown
  try {
    body = await request.json()
  } catch {
    error(400, 'Expected JSON body { keys: string[] }')
  }
  try {
    return json(await _deps.run(locals.user, 'notifications.mark_read', body))
  } catch (e) {
    fail(e)
  }
}
