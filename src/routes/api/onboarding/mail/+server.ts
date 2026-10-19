import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { isUserAdmin } from '$lib/server/auth/user-role'
import { companyMail } from '$lib/server/mail'

/**
 * The onboarding's email step (and Settings → Email): the owner enters their
 * Owlery details; a real test email goes to the owner's own address first, and
 * the settings are stored (key sealed) only if it went through.
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
      baseUrl: field('baseUrl'),
      apiKey: field('apiKey'),
      emailFrom: field('emailFrom'),
      contactBookId: field('contactBookId') || null,
      testRecipient: user.email,
      updatedBy: user.id,
    })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
  return json({ ok: true, testSentTo: user.email })
}
