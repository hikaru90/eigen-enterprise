import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { handleMailSend } from '$lib/server/mail/api-send'
import { mailSendDeps } from '$lib/server/mail/api-send-store'

/**
 * POST /api/mail/send — API keys only (docs/agents/send-mail.md). A session
 * cookie never sets locals.apiKeyAuth, so cookie callers get 401.
 */
export const POST: RequestHandler = async (event) => {
  const apiKey = event.locals.apiKeyAuth ?? null
  if (!apiKey || !event.locals.user) return json({ error: 'unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await event.request.json()
  } catch {
    return json({ error: 'invalid_request', fields: { body: 'must be JSON' } }, { status: 400 })
  }
  const res = await handleMailSend(mailSendDeps(event.locals.user.id), { apiKey, body })
  return json(res.body, { status: res.status, headers: res.headers })
}
