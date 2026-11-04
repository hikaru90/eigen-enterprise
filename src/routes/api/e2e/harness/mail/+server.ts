import type { RequestHandler } from './$types'
import { error, json } from '@sveltejs/kit'
import { dev } from '$app/environment'
import { defaultFakeMailStore } from '../../../../../../modules/email/owlery/fake-store'
import { configuredMailTransport, owleryService } from '../../../../../../modules/email/owlery/service'
import { emailPlatform } from '../../../../../../modules/email/platform/service'

/**
 * Dev/e2e only: the fake mail transport's inbox (MAIL_TRANSPORT=fake).
 *
 *   GET    ?to=<address>         → { mails }  captured mails, oldest first
 *   POST   { verify: <identity> } → marks a fake SES identity (address or domain) verified
 *   POST   { sesEvent: {...} }    → applies an SES event as if SNS had delivered it
 *                                  (the signed SNS path is unit-tested; no SNS exists here)
 *   POST   { tick: true }         → runs the email module's background pass now
 *                                  (domain re-checks, due scheduled sends)
 *   DELETE                       → forgets captured mails, identities, the email
 *                                  platform's rows AND the company's mail settings
 *                                  (a clean slate per test)
 *
 * Guarded like the other harness routes (dev only), and refused unless the
 * app runs the fake transport — it never touches a real SES setup's state.
 */
function guard(): Response | null {
  if (!dev) return json({ error: 'Mail harness API only available in dev mode' }, { status: 403 })
  if (configuredMailTransport() !== 'fake') {
    return json({ error: 'The mail harness needs the app to run with MAIL_TRANSPORT=fake' }, { status: 409 })
  }
  return null
}

export const GET: RequestHandler = async ({ url }) => {
  const refused = guard()
  if (refused) return refused
  const to = url.searchParams.get('to')?.trim()
  return json({ mails: await defaultFakeMailStore().list(to ? { to } : {}) })
}

export const POST: RequestHandler = async ({ request }) => {
  const refused = guard()
  if (refused) return refused
  let body: { verify?: unknown; sesEvent?: unknown; tick?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    error(400, 'Invalid JSON body')
  }
  if (body.sesEvent !== undefined) return json(await emailPlatform().applySesEvent(body.sesEvent))
  if (body.tick === true) return json(await emailPlatform().tick())
  const identity = typeof body.verify === 'string' ? body.verify.trim() : ''
  if (!identity) error(400, 'verify (an email address or domain) is required')
  await defaultFakeMailStore().verifyIdentity(identity)
  return json({ ok: true, verified: identity })
}

export const DELETE: RequestHandler = async () => {
  const refused = guard()
  if (refused) return refused
  await defaultFakeMailStore().clear()
  await emailPlatform().audience.clearAll()
  await emailPlatform().store.clearAll()
  await owleryService().forgetSettings()
  return json({ ok: true })
}
