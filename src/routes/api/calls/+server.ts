import type { RequestHandler } from './$types'
import { readJson, startInputOf } from '../../../../modules/calls/http'
import { callsRoute } from './calls-route'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../modules/index')).liveCallsService(),
}

/** The signed-in person's calls, newest first. */
export const GET: RequestHandler = ({ locals }) =>
  callsRoute('Listing my calls', locals.user, _deps.service, async (userId, s) => ({
    calls: await s.list({ kind: 'user', userId }),
  }))

/** Start a call: { contextKind: 'dm'|'channel', contextId } or { contextKind: 'meeting', userIds, title? }. */
export const POST: RequestHandler = ({ locals, request }) =>
  callsRoute('Starting a call', locals.user, _deps.service, async (userId, s) => ({
    call: await s.start({ kind: 'user', userId }, startInputOf(await readJson(request))),
  }))
