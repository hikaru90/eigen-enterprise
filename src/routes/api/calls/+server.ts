import type { RequestHandler } from './$types'
import { callsRoute, readJson, startInputOf } from '../../../../modules/calls/http'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../modules/index')).liveCallsService(),
}

/** The signed-in person's calls, newest first. */
export const GET: RequestHandler = ({ locals }) =>
  callsRoute(locals.user, _deps.service, async (userId, s) => ({ calls: await s.list({ kind: 'user', userId }) }))

/** Start a call: { contextKind: 'dm'|'channel', contextId } or { contextKind: 'meeting', userIds, title? }. */
export const POST: RequestHandler = ({ locals, request }) =>
  callsRoute(locals.user, _deps.service, async (userId, s) => ({
    call: await s.start({ kind: 'user', userId }, startInputOf(await readJson(request))),
  }))
