import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { messagesStreamResponse, parseLastEventId } from '../../../../../modules/messages/hub'

/**
 * The signed-in person's live feed (SSE): new/edited/deleted messages,
 * new conversations and read-state, only for conversations they may see —
 * and, for company members, everyone's presence (`event: presence`).
 * Resumes from Last-Event-ID (browser reconnect) or ?after=<id> (first
 * connect, the id the page loaded at).
 */
export const GET: RequestHandler = async ({ locals, request, url }) => {
  if (!locals.user) return json({ error: 'sign in first' }, { status: 401 })
  const { messagesDeps, messagesHub } = await import('../../../../../modules/messages/live')
  const { presenceStreamFor } = await import('../../../../../modules/messages/presence')
  const [hub, d] = await Promise.all([messagesHub(), messagesDeps()])
  const resume = parseLastEventId(request.headers.get('last-event-id')) ?? parseLastEventId(url.searchParams.get('after'))
  const tracker = async () => (await import('$lib/server/presence')).presence()
  const feed = await presenceStreamFor(d, tracker, locals.user.id)
  return messagesStreamResponse(hub, locals.user.id, resume, request.signal, feed)
}
