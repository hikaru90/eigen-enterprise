import { error, fail, redirect } from '@sveltejs/kit'
import type { ErrorReport } from '$lib/errors/agent-report'
import { isUserAdmin } from '$lib/server/auth/user-role'
import { errorReport, refusalReport } from '$lib/server/errors/report'
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
 * the plain message (the error's own sentence, unchanged) and the agent half of
 * the one error shape ($lib/errors/agent-report); everything else is a real
 * error. `attempted` says what the person was doing, in words, for the agent.
 */
export async function act<T extends Record<string, unknown>>(
  action: string,
  attempted: string,
  run: () => Promise<T>,
) {
  try {
    return { action, ok: true as const, ...(await run()) }
  } catch (err) {
    if (err instanceof TemplateRenderError)
      return fail(400, {
        action,
        ...errorReport(err, { attempted, plain: () => err.message }),
        problems: err.problems,
      })
    if (
      err instanceof EmailPlatformError ||
      err instanceof TemplateError ||
      err instanceof AudienceError ||
      err instanceof InboxError ||
      err instanceof MailSetupError ||
      err instanceof MailNotConfiguredError
    ) {
      return fail(400, { action, ...errorReport(err, { attempted, plain: () => err.message }) })
    }
    throw err
  }
}

/**
 * A change that was saved while the SES receipt rules could not follow it:
 * Amazon's reason (already plain words) with the agent half, or null.
 */
export function receivingReport(reason: string | null, attempted: string): ErrorReport | null {
  if (reason === null) return null
  return refusalReport(reason, {
    attempted,
    cause: reason,
    nextSteps: [
      'The change itself was saved; only the Amazon SES receipt-rule sync failed (EmailPlatform.syncReceiving in modules/email/platform/service.ts, rules in modules/email/owlery/receiving.ts). The reason is also stored on the receiving state, shown under Email › Setup › Account.',
      'Fix what the reason names (usually the AWS keys’ IAM permissions), then make any mailbox change or use Setup › Account to sync again.',
    ],
  })
}

export function field(form: FormData, key: string): string {
  const v = form.get(key)
  return typeof v === 'string' ? v.trim() : ''
}
