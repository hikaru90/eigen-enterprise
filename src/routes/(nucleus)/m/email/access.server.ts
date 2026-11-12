import { error, fail, redirect } from '@sveltejs/kit'
import { isUserAdmin } from '$lib/server/auth/user-role'
import { MailNotConfiguredError, MailSetupError } from '$lib/server/mail/company-mail'
import { InboxError } from '../../../../../modules/email/inbox/errors'
import { AudienceError } from '../../../../../modules/email/platform/flows/service'
import { EmailPlatformError } from '../../../../../modules/email/platform/service'
import {
  TemplateError,
  TemplateRenderError,
} from '../../../../../modules/email/platform/templates/service'

/**
 * Who may do what in the Email area: every signed-in member reads; the owner
 * and admins change things (connect SES, domains, senders, suppressions, keys).
 */

export async function requireMember(
  locals: App.Locals,
): Promise<{ userId: string; email: string; isAdmin: boolean }> {
  const user = locals.user
  if (!user) throw redirect(302, '/login')
  return { userId: user.id, email: user.email, isAdmin: await isUserAdmin(user.id) }
}

export async function requireAdmin(locals: App.Locals): Promise<{ userId: string; email: string }> {
  const me = await requireMember(locals)
  if (!me.isAdmin) error(403, 'Only the owner or an admin can change email settings.')
  return me
}

/**
 * Runs a form action; problems the owner can fix come back as `fail(400)` with
 * the plain message, everything else is a real error.
 */
export async function act<T extends Record<string, unknown>>(
  action: string,
  run: () => Promise<T>,
) {
  try {
    return { action, ok: true as const, ...(await run()) }
  } catch (err) {
    if (err instanceof TemplateRenderError)
      return fail(400, { action, error: err.message, problems: err.problems })
    if (
      err instanceof EmailPlatformError ||
      err instanceof TemplateError ||
      err instanceof AudienceError ||
      err instanceof InboxError ||
      err instanceof MailSetupError ||
      err instanceof MailNotConfiguredError
    ) {
      return fail(400, { action, error: err.message })
    }
    throw err
  }
}

export function field(form: FormData, key: string): string {
  const v = form.get(key)
  return typeof v === 'string' ? v.trim() : ''
}
