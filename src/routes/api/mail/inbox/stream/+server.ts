import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { inboxStreamResponse } from '../../../../../../modules/email/inbox/hub'

/**
 * The signed-in person's live mail (SSE, S4): `event: mailbox` with
 * `{ mailboxId }` whenever mail in a mailbox they read arrives or changes.
 * Access is re-checked for every event; nothing about the mail is sent.
 */
export const GET: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) return json({ error: 'sign in first' }, { status: 401 })
  const { inboxHub } = await import('../../../../../../modules/email/inbox/live')
  return inboxStreamResponse(await inboxHub(), locals.user.id, request.signal)
}
