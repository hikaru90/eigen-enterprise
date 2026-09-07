import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import type { OwleryEnv } from '$lib/server/owlery/config'
import {
  runAddContactTool,
  runListContactsTool,
  runSendMailTool,
} from '$lib/server/owlery/tools'

/**
 * Kernel tool descriptors wrapping the Owlery mail + contact book runners
 * (src/lib/server/owlery/tools.ts, thin wrappers over mail.ts / contacts.ts).
 * The private env is resolved lazily at call time (never at import time), and
 * configuration gaps fail loud inside the runners via owlery config.ts.
 */

export type EmailToolDeps = {
  /** Overrides $lib/server/env/private-env (tests). */
  env?: OwleryEnv
  /** Overrides global fetch (tests). */
  fetchImpl?: typeof fetch
}

async function resolveEnv(deps: EmailToolDeps): Promise<OwleryEnv> {
  if (deps.env) return deps.env
  const { env } = await import('$lib/server/env/private-env')
  return env
}

const sendMailInput = z.object({
  to: z.email(),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().min(1),
  replyTo: z.email().optional(),
})

const addContactInput = z.object({
  email: z.email(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
})

/** Kernel descriptors for the Owlery email + contacts surface. */
export function createEmailTools(deps: EmailToolDeps = {}): ToolDescriptor[] {
  return [
    {
      name: 'email.send_mail',
      module: 'email',
      summary:
        'Send one transactional email via Owlery. Fails loud when Owlery mail is not configured.',
      auditClass: 'external',
      inputSchema: sendMailInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) =>
        runSendMailTool(await resolveEnv(deps), sendMailInput.parse(input), deps.fetchImpl),
    },
    {
      name: 'email.add_contact',
      module: 'email',
      summary: 'Add one pre-confirmed contact to the onboarding contact book.',
      auditClass: 'mutate',
      inputSchema: addContactInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) =>
        runAddContactTool(await resolveEnv(deps), addContactInput.parse(input), deps.fetchImpl),
    },
    {
      name: 'email.list_contacts',
      module: 'email',
      summary:
        'List contacts in the onboarding contact book. Fails loud when the contact book is not configured.',
      auditClass: 'read',
      inputSchema: z.object({}),
      permission: { roles: ['admin', 'agent'] },
      handler: async () => runListContactsTool(await resolveEnv(deps), deps.fetchImpl),
    },
  ]
}
