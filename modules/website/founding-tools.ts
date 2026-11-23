import { z } from 'zod'
import type { FoundingInterviewAnswers, FoundingRecordResult } from '$lib/server/onboarding/founding'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { KernelError } from '$lib/kernel/errors'
import { WEBSITE_MODULE_ID } from './manifest'

/**
 * website.found_company: the welcome's founding interview (tone of voice,
 * company name, positioning) as one act — the same foundCompanyWebsite the
 * wizard's POST /api/onboarding/founding calls. Owner or admin only, as the
 * person behind the call; the artifacts (website.create_page, …) run as that
 * person through the registry and every publish waits on the approval gate.
 */

export const WEBSITE_FOUNDING_TOOL = 'website.found_company'

export type FoundingPort = {
  isAdmin(userId: string): Promise<boolean>
  /** Throws AlreadyFoundedError when the founding pages exist and no journey is open. */
  found(principal: ToolContext['principal'], answers: FoundingInterviewAnswers): Promise<FoundingRecordResult>
}

const input = z
  .object({
    tone: z.string().max(2000).optional(),
    company_name: z.string().max(200).optional(),
    positioning: z.string().max(2000).optional(),
  })
  .strict()

async function livePort(): Promise<FoundingPort> {
  const [{ bootApp }, founding, { isUserAdmin }] = await Promise.all([
    import('$lib/server/boot'),
    import('$lib/server/onboarding/founding'),
    import('$lib/server/auth/user-role'),
  ])
  return {
    isAdmin: isUserAdmin,
    found: async (principal, answers) => {
      const boot = await bootApp()
      try {
        return await founding.foundCompanyWebsite({
          registry: boot.kernel.registry,
          journeys: boot.journeys,
          eventSink: boot.kernel.eventSink,
          sessionId: `tool:${principal.id}`,
          principal,
          answers,
        })
      } catch (err) {
        if (err instanceof founding.AlreadyFoundedError) throw new KernelError('invalid_input', err.message)
        throw err
      }
    },
  }
}

export function createWebsiteFoundingTools(opts: { port?: () => Promise<FoundingPort> } = {}): ToolDescriptor[] {
  const port = opts.port ?? livePort
  return [
    {
      name: WEBSITE_FOUNDING_TOOL,
      module: WEBSITE_MODULE_ID,
      summary:
        'Found the company website from the founding interview, once: tone of voice, company name and positioning (all optional; all blank = skipped). Creates the tone-of-voice brand page and the home, about and contact pages; publishing them waits for the owner’s approval. Refused when the company is already founded — then change pages with website.update_page.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: () => 'Founded the company website from the founding interview',
      inputSchema: input,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, raw) => {
        const i = input.parse(raw)
        if (ctx.principal.kind !== 'human') {
          throw new KernelError('no_person', 'The founding interview is a person’s (the owner or an admin); this call runs as no person.')
        }
        const p = await port()
        if (!(await p.isAdmin(ctx.principal.id))) {
          throw new KernelError('permission_denied', 'Only the owner or an admin founds the company website.')
        }
        return p.found(ctx.principal, { tone: i.tone, companyName: i.company_name, positioning: i.positioning })
      },
    },
  ]
}
