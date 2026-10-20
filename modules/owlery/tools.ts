import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import { owleryService, type OwleryService } from './service'

/**
 * Kernel tools for the company's email. `owlery.send_mail` sits behind the
 * kernel approval gate (APPROVAL_REQUIRED_TOOLS): an agent's send waits for
 * the owner's yes.
 */

export type OwleryToolDeps = { service?: Pick<OwleryService, 'status' | 'send'> }

const sendMailInput = z
  .object({
    to: z.email(),
    subject: z.string().min(1),
    html: z.string().min(1),
    text: z.string().min(1),
    replyTo: z.email().optional(),
  })
  .strict()

export function createOwleryTools(deps: OwleryToolDeps = {}): ToolDescriptor[] {
  const service = () => deps.service ?? owleryService()
  return [
    {
      name: 'owlery.status',
      module: 'owlery',
      summary:
        'Whether company email is set up: SES region, sender address, whether Amazon verified the sender, and whether the account is still in the SES sandbox.',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      permission: { roles: ['admin', 'agent'] },
      handler: async () => service().status(),
    },
    {
      name: 'owlery.send_mail',
      module: 'owlery',
      summary: "Send one email from the company's sender address. Needs the owner's approval.",
      auditClass: 'mutate',
      // Recipient only: subject and body stay out of the audit trail.
      activity: (input: z.infer<typeof sendMailInput>) => `Sent an email to ${input.to}`,
      approvalRisk: 'external',
      inputSchema: sendMailInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => service().send(sendMailInput.parse(input)),
    },
  ]
}
