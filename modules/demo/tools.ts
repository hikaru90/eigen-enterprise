import type { DemoDataset, Teammate } from './types'
import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import type { ToolDescriptor } from '$lib/kernel/types'
import { northwind } from './data/dataset'
import { DEMO_MODULE_ID, DEMO_SEED_TOOL, DEMO_STATUS_TOOL } from './manifest'
import { asMembersList, seedDemoCompany, seedState, type PersonPrincipal, type SeedDeps } from './runner'

/**
 * demo.* kernel tools (plan/phase-demo-company.md DC1): the seed runs inside
 * the running server, so it works on any installed box (`ee` through the
 * company brain, MCP, the in-app assistant). demo.seed_company runs the
 * runner in process: every write is a registry tool executed as the person it
 * belongs to (the owner, or the teammate). It waits on the approval mode
 * (APPROVAL_REQUIRED_TOOLS) and is audited like every call.
 */

/** What the tools need from the server (modules/demo/live.ts; tests inject fakes). */
export type DemoPorts = {
  /** The member's company role, or null when there is no such member. */
  roleOf(userId: string): Promise<'owner' | 'admin' | 'member' | null>
  /** The member as a principal: their id and kernel roles (what they may do as themselves). */
  personOf(userId: string): Promise<PersonPrincipal>
  /** Make a teammate a real member: the owner invites, the invite is accepted. */
  addTeammate(owner: PersonPrincipal, t: Teammate): Promise<PersonPrincipal>
}

export type DemoToolsOptions = {
  /** The registry the seed drives (the kernel's own; a closure because the registry is built first). */
  registry: () => SeedDeps['registry']
  ports?: () => Promise<DemoPorts>
  dataset?: DemoDataset
  now?: () => Date
  log?: (line: string) => void
}

const noInput = z.object({}).strict()

async function livePorts(): Promise<DemoPorts> {
  const { demoPorts } = await import('./live')
  return demoPorts()
}

export function createDemoTools(opts: DemoToolsOptions): ToolDescriptor[] {
  const dataset = opts.dataset ?? northwind
  const ports = opts.ports ?? livePorts
  const now = opts.now ?? (() => new Date())
  const log = opts.log ?? ((line: string) => console.info(`[demo] ${line}`))
  return [
    {
      name: DEMO_SEED_TOOL,
      module: DEMO_MODULE_ID,
      summary: `Fill this freshly claimed company with the demo company ${dataset.companyName}: teammates (real members, fictitious addresses, no mail sent), groups, contacts and pipeline, projects and tasks, channels and messages, calendar events, Drive documents, brand voice, published website pages and shared notes, dated around today. Owner only. Refused, writing nothing, when the company is already seeded or is not freshly claimed (the owner must be the only member, with no open invites). Takes a while; returns what was made.`,
      auditClass: 'mutate',
      // Publishes website pages to the world and makes member accounts.
      approvalRisk: 'public',
      activity: () => `Seeded the demo company ${dataset.companyName}`,
      inputSchema: noInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        noInput.parse(input)
        const p = await ports()
        // The owner's own act: their session, their API key, or the brain acting for them.
        if ((await p.roleOf(ctx.principal.id)) !== 'owner') {
          throw new KernelError(
            'permission_denied',
            `${DEMO_SEED_TOOL} is the owner's: only the person who claimed the company seeds it`,
          )
        }
        const owner = await p.personOf(ctx.principal.id)
        const counts = await seedDemoCompany(dataset, {
          registry: opts.registry(),
          owner,
          addTeammate: (t) => p.addTeammate(owner, t),
          now: now(),
          log,
        })
        return { seeded: dataset.companyName, ...counts }
      },
    },
    {
      name: DEMO_STATUS_TOOL,
      module: DEMO_MODULE_ID,
      summary: `Whether this company holds the demo company ${dataset.companyName} (seeded, and its teammates' addresses) and whether demo.seed_company can run (freshly claimed: the owner the only member, no open invites).`,
      auditClass: 'read',
      inputSchema: noInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        noInput.parse(input)
        const s = seedState(dataset, asMembersList(await opts.registry().execute('members.list', {}, ctx)))
        return {
          company: dataset.companyName,
          seeded: s.seeded,
          seeded_members: s.seededMembers,
          members: s.members,
          open_invites: s.openInvites,
          can_seed: !s.seeded && s.fresh,
        }
      },
    },
  ]
}
