import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { loadAssistantConversation } from '$lib/server/assistant/conversation'

/**
 * The assistant panel's current conversation (polish P-1). Read-only; new
 * turns go through POST /api/chat with the returned session id.
 */
export const GET: RequestHandler = async ({ locals, fetch }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 })
  return json(await loadAssistantConversation(locals.user.id, fetch))
}
