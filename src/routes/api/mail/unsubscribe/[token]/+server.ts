import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { emailPlatform } from '../../../../../../modules/email/platform/service'

/**
 * POST /api/mail/unsubscribe/<token> — RFC 8058 one-click unsubscribe, the
 * target of the List-Unsubscribe header. Mailbox providers POST
 * "List-Unsubscribe=One-Click" without an Origin (exempt from the cross-site
 * form check, $lib/server/csrf); the token is the authorisation and this can
 * only unsubscribe.
 */
export const POST: RequestHandler = async ({ params }) => {
  const c = await emailPlatform().audience.unsubscribe(params.token)
  if (!c) return json({ error: 'unknown token' }, { status: 404 })
  return json({ ok: true, unsubscribed: true })
}
