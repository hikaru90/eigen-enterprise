import type { CallsService, ScheduleInput, StartInput } from './service'
import { json } from '@sveltejs/kit'
import { CallsError } from './errors'

/**
 * Shared plumbing for /api/calls/*: signed-in only, the live service, and
 * CallsError → HTTP status (not_found 404, forbidden 403, invalid 400,
 * conflict 409, not_configured 503 — "Calls are not set up on this server").
 * Anything else is a 500 with its message, logged.
 */

const STATUS: Record<CallsError['code'], number> = { not_found: 404, forbidden: 403, invalid: 400, conflict: 409, not_configured: 503 }

export async function callsRoute(
  user: { id: string } | null | undefined,
  service: () => Promise<CallsService>,
  run: (userId: string, service: CallsService) => Promise<unknown>,
): Promise<Response> {
  if (!user) return json({ error: 'sign in first' }, { status: 401 })
  try {
    const out = await run(user.id, await service())
    return out instanceof Response ? out : json(out ?? { ok: true })
  } catch (err) {
    if (err instanceof CallsError) return json({ error: err.message, code: err.code }, { status: STATUS[err.code] })
    console.error('[calls] request failed', err)
    return json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

/**
 * The public guest routes (/api/calls/guest/[token]/*): no session — the
 * unguessable link token is the proof, checked by the service. Same error
 * mapping; never cached.
 */
export async function guestRoute(service: () => Promise<CallsService>, run: (service: CallsService) => Promise<unknown>): Promise<Response> {
  const headers = { 'cache-control': 'no-store' }
  try {
    return json(await run(await service()), { headers })
  } catch (err) {
    if (err instanceof CallsError) return json({ error: err.message, code: err.code }, { status: STATUS[err.code], headers })
    console.error('[calls] guest request failed', err)
    return json({ error: err instanceof Error ? err.message : String(err) }, { status: 500, headers })
  }
}

/** POST /api/calls/meetings body → ScheduleInput (shape only; the service validates emails, times, links). */
export function scheduleInputOf(body: Record<string, unknown>): ScheduleInput {
  const { userIds, guests, title, startsAt, durationMinutes, externalUrl, timeZone } = body
  if (userIds !== undefined && (!Array.isArray(userIds) || userIds.some((u) => typeof u !== 'string'))) {
    throw new CallsError('invalid', 'userIds must be a list of ids')
  }
  if (title !== undefined && title !== null && typeof title !== 'string') throw new CallsError('invalid', 'title must be text')
  if (startsAt !== undefined && startsAt !== null && typeof startsAt !== 'string') throw new CallsError('invalid', 'startsAt is an ISO time or null (now)')
  const start = typeof startsAt === 'string' ? new Date(startsAt) : null
  if (start && Number.isNaN(start.getTime())) throw new CallsError('invalid', 'startsAt is not a time')
  if (durationMinutes !== undefined && durationMinutes !== null && typeof durationMinutes !== 'number') {
    throw new CallsError('invalid', 'durationMinutes must be a number')
  }
  if (externalUrl !== undefined && externalUrl !== null && typeof externalUrl !== 'string') throw new CallsError('invalid', 'externalUrl must be text')
  return {
    userIds: userIds as string[] | undefined,
    guests,
    title: title ?? null,
    startsAt: start,
    durationMinutes: durationMinutes ?? null,
    externalUrl: externalUrl ?? null,
    timeZone,
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>
  } catch {
    // fall through
  }
  throw new CallsError('invalid', 'expected a JSON object body')
}

/** POST /api/calls body → StartInput (shape only; the service decides the rest). */
export function startInputOf(body: Record<string, unknown>): StartInput {
  const { contextKind, contextId, userIds, title } = body
  if (contextKind !== 'dm' && contextKind !== 'channel' && contextKind !== 'meeting') {
    throw new CallsError('invalid', 'contextKind is dm, channel or meeting')
  }
  if (contextId !== undefined && contextId !== null && typeof contextId !== 'string') throw new CallsError('invalid', 'contextId must be a string')
  if (userIds !== undefined && (!Array.isArray(userIds) || userIds.some((u) => typeof u !== 'string'))) {
    throw new CallsError('invalid', 'userIds must be a list of ids')
  }
  if (title !== undefined && title !== null && typeof title !== 'string') throw new CallsError('invalid', 'title must be text')
  return { contextKind, contextId: contextId ?? null, userIds: userIds as string[] | undefined, title: title ?? null }
}
