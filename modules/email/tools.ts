import { EMAIL_MODULE_ID } from './manifest'
import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import type { CompanyMail } from '$lib/server/mail/company-mail'

/**
 * `email.send_mail` — the one tool that sends company email (plan/phase-module-
 * readiness.md E4). It goes through companyMail() (delivered by the Owlery SES
 * module, or the fake under MAIL_TRANSPORT=fake), holds no credentials, and
 * sits behind the kernel approval gate (APPROVAL_REQUIRED_TOOLS): a send waits
 * for the owner's yes.
 */

export type EmailToolDeps = {
  /** Overrides companyMail() from $lib/server/mail (tests). */
  mail?: Pick<CompanyMail, 'send'>
}

async function resolveMail(deps: EmailToolDeps): Promise<Pick<CompanyMail, 'send'>> {
  if (deps.mail) return deps.mail
  const { companyMail } = await import('$lib/server/mail')
  return companyMail()
}

const sendMailInput = z.object({
  to: z.email(),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().min(1),
  replyTo: z.email().optional(),
})

export function createEmailTools(deps: EmailToolDeps = {}): ToolDescriptor[] {
  return [
    {
      name: 'email.send_mail',
      module: EMAIL_MODULE_ID,
      summary:
        "Send one transactional email from the company's sender address. Fails loud when email is not set up.",
      auditClass: 'external',
      // Recipient only: subject and body stay out of the audit trail.
      activity: (input: z.infer<typeof sendMailInput>) => `Sent an email to ${input.to}`,
      approvalRisk: 'external',
      inputSchema: sendMailInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => (await resolveMail(deps)).send(sendMailInput.parse(input)),
    },
  ]
}
