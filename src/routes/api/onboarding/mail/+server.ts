import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { isUserAdmin } from '$lib/server/auth/user-role'
import { companyMail, MailSetupError, SenderNotVerifiedError } from '$lib/server/mail'
import { owleryService } from '../../../../../modules/email/owlery/service'

/**
 * Connect Amazon SES — the welcome wizard's email step and the Email page's
 * "Connect Amazon SES" form both post here. A real test email goes to the
 * owner's own address first; the settings are stored (secret sealed) only if
 * it went through. Then delivery events are wired (SNS → /api/mail/ses-events);
 * their outcome is stored and shown on the Email page, never a reason to fail
 * the connect.
 *
 *   200 { ok: true, testSentTo, events }
 *   409 { error, needs: 'verify_sender', emailFrom }  — click Amazon's link, then retry
 *   400 { error }                                     — anything else
 */
export const POST: RequestHandler = async (event) => {
  const user = event.locals.user
  if (!user) return json({ error: 'You must be signed in.' }, { status: 401 })
  if (!(await isUserAdmin(user.id))) return json({ error: 'Only the owner sets up email.' }, { status: 403 })

  let body: Record<string, unknown>
  try {
    body = (await event.request.json()) as Record<string, unknown>
  } catch {
    return json({ error: 'Request body must be JSON.' }, { status: 400 })
  }
  const field = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '')

  try {
    await companyMail().saveVerified({
      region: field('region'),
      accessKeyId: field('accessKeyId'),
      secretAccessKey: field('secretAccessKey'),
      emailFrom: field('emailFrom'),
      testRecipient: user.email,
      updatedBy: user.id,
    })
  } catch (err) {
    if (err instanceof SenderNotVerifiedError) {
      return json({ error: err.message, needs: 'verify_sender', emailFrom: err.emailFrom }, { status: 409 })
    }
    if (err instanceof MailSetupError) return json({ error: err.message }, { status: 400 })
    console.error('[onboarding/mail] email setup failed', { userId: user.id, error: err instanceof Error ? err.message : String(err) })
    return json({ error: 'Email setup failed unexpectedly. Please try again.' }, { status: 400 })
  }
  const events = await owleryService().setupEvents(new URL(event.request.url).origin)
  return json({ ok: true, testSentTo: user.email, events: events.eventsStatus })
}
