import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import { EeClient, SubstrateUnavailableError } from '$lib/server/ee/client'
import { requireHuman } from '$lib/server/ee/human'

/**
 * Kernel descriptors over ee's control API. Reads are open to the agent;
 * every mutation is human-only (plan/phase-substrate.md D11): the agent reads
 * text an attacker can influence (repos, logs, webhooks), so it never gets to
 * change the box on the strength of it. Commits in the company repo carry the
 * human principal as author.
 */

export type SubstrateToolDeps = { client?: EeClient }

const HOST = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/, 'not a valid hostname')

const domainAddInput = z.object({
  host: HOST,
  role: z.enum(['public', 'console', 'app']),
  /** The workload the host serves; eigenEnterprise itself is "os". */
  workload: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/).default('os'),
})
const domainRemoveInput = z.object({ host: HOST })
const appRemoveInput = z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/) })
const secretSetInput = z.object({
  workload: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  value: z.string().min(1),
})

export function createSubstrateTools(deps: SubstrateToolDeps = {}): ToolDescriptor[] {
  const client = deps.client ?? new EeClient()

  return [
    {
      name: 'substrate.status',
      module: 'substrate',
      summary:
        'What runs on this server: domains, workloads (eigenEnterprise and apps), what is live, recent deploy events. Reports managed:false when not running under ee.',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      permission: { roles: ['admin', 'agent'] },
      handler: async () => {
        try {
          return { managed: true as const, ...(await client.status()) }
        } catch (err) {
          if (err instanceof SubstrateUnavailableError) return { managed: false as const, reason: err.message }
          throw err
        }
      },
    },
    {
      name: 'substrate.domain_add',
      module: 'substrate',
      summary:
        'Point a domain at this server (human only). role "public" = the public website, "console" = this app, "app" = another deployed app. DNS must already point here.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof domainAddInput>) => `Pointed the domain ${input.host} at this server`,
      inputSchema: domainAddInput,
      permission: { roles: ['admin'] },
      handler: async (ctx, input) => {
        const author = requireHuman(ctx, 'substrate.domain_add')
        const i = domainAddInput.parse(input)
        return client.addDomain({ ...i, author })
      },
    },
    {
      name: 'substrate.domain_remove',
      module: 'substrate',
      summary: 'Remove a domain from this server (human only). The console host cannot be removed.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof domainRemoveInput>) => `Removed the domain ${input.host} from this server`,
      inputSchema: domainRemoveInput,
      permission: { roles: ['admin'] },
      handler: async (ctx, input) => {
        const author = requireHuman(ctx, 'substrate.domain_remove')
        return client.removeDomain({ ...domainRemoveInput.parse(input), author })
      },
    },
    {
      name: 'substrate.app_remove',
      module: 'substrate',
      summary: 'Stop and remove a deployed app and its domains (human only). System workloads cannot be removed.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof appRemoveInput>) => `Removed the app “${input.name}” from this server`,
      inputSchema: appRemoveInput,
      permission: { roles: ['admin'] },
      handler: async (ctx, input) => {
        const author = requireHuman(ctx, 'substrate.app_remove')
        return client.removeApp({ ...appRemoveInput.parse(input), author })
      },
    },
    {
      name: 'substrate.secret_set',
      module: 'substrate',
      summary: "Set a secret for a deployed app (human only). Values are write-only: they can never be read back.",
      auditClass: 'mutate',
      // Names the secret, never its value.
      activity: (input: z.infer<typeof secretSetInput>) =>
        `Set the secret ${input.name} for the app “${input.workload}”`,
      inputSchema: secretSetInput,
      permission: { roles: ['admin'] },
      handler: async (ctx, input) => {
        const author = requireHuman(ctx, 'substrate.secret_set')
        const i = secretSetInput.parse(input)
        const r = await client.setSecret({ ...i, author })
        return { ok: true, name: i.name, workload: i.workload, reconcileError: r.reconcileError }
      },
    },
  ]
}
