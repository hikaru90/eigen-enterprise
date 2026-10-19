import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import type { CompanyMail } from '$lib/server/mail/company-mail'

/**
 * The legacy `email.send_mail` tool, now sending through the shared company
 * mail path (companyMail() — delivered by the Owlery SES module). It holds no
 * credentials. The old Owlery contact-book tools are gone: the SES module has
 * no contact book yet.
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
      module: 'email',
      summary:
        "Send one transactional email from the company's sender address. Fails loud when email is not set up.",
      auditClass: 'external',
      inputSchema: sendMailInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => (await resolveMail(deps)).send(sendMailInput.parse(input)),
    },
  ]
}
