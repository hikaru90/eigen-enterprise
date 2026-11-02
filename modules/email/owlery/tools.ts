import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import { EMAIL_MODULE_ID } from '../manifest'
import { owleryService, type OwleryService } from './service'

/**
 * Kernel tools for the company's email setup. Sending is `email.send_mail`
 * (modules/email/tools.ts) — the one send tool; `owlery.send_mail` was removed
 * (plan/phase-module-readiness.md E4).
 */

export type OwleryToolDeps = { service?: Pick<OwleryService, 'status'> }

export function createOwleryTools(deps: OwleryToolDeps = {}): ToolDescriptor[] {
  const service = () => deps.service ?? owleryService()
  return [
    {
      name: 'owlery.status',
      module: EMAIL_MODULE_ID,
      summary:
        'Whether company email is set up: SES region, sender address, whether Amazon verified the sender, and whether the account is still in the SES sandbox.',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      permission: { roles: ['admin', 'agent'] },
      handler: async () => service().status(),
    },
  ]
}
