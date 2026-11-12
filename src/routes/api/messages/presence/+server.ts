import type { RequestHandler } from './$types'
import { messagesRoute, readJson } from '../../../../../modules/messages/http'
import { reportPresence, setDoNotDisturb } from '../../../../../modules/messages/presence'

const tracker = async () => (await import('$lib/server/presence')).presence()

/** Heartbeat { clientId, state: active | idle | gone } from one of the person's tabs. */
export const POST: RequestHandler = ({ locals, request }) =>
  messagesRoute(locals.user, async (userId, d) => {
    await reportPresence(d, await tracker(), userId, await readJson(request))
  })

/** { doNotDisturb: boolean } — the person's own toggle; answers their presence. */
export const PUT: RequestHandler = ({ locals, request }) =>
  messagesRoute(locals.user, async (userId, d) => ({
    presence: await setDoNotDisturb(d, await tracker(), userId, await readJson(request)),
  }))
