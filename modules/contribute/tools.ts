import type { HubProposalDto } from './hub/types'
import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { CONTRIBUTE_MODULE_ID } from './manifest'
import { ContributeError } from './errors'
import {
  getProposal,
  listProposals,
  shareProposal,
  updateProposal,
  voteProposal,
  type ContributeActor,
  type ContributeDeps,
} from './service'
import {
  CONTRIBUTION_AREAS,
  CONTRIBUTION_KINDS,
  CONTRIBUTION_NOTE_MAX_LENGTH,
  CONTRIBUTION_STATUSES, OPEN_STATUSES, type ContributionDto, type ContributionStatus } from './types'

/**
 * contribute.* kernel tools: how an agent picks up what people proposed
 * (in-app assistant, `ee contribute.list`). Read the board, then move a
 * proposal to in_progress with a note when work starts and to shipped when
 * it is live — people see both on the board. Proposing and voting are a
 * person's (their name and their vote): a person in the CLI, or the brain
 * acting as them; the agent on its own is refused.
 */

const listInput = z
  .object({
    status: z
      .enum([...CONTRIBUTION_STATUSES, 'open', 'all'])
      .default('open')
      .describe('"open" (default) = requested + in_progress; "all" = everything incl. shipped and declined'),
  })
  .strict()
const getInput = z.object({ id: z.string().min(1) }).strict()
const updateInput = z
  .object({
    id: z.string().min(1),
    status: z.enum(CONTRIBUTION_STATUSES).optional(),
    note: z.string().max(CONTRIBUTION_NOTE_MAX_LENGTH).nullable().optional().describe('shown on the proposal; null clears it'),
  })
  .strict()

const proposeInput = z
  .object({
    title: z.string().min(1).describe('the improvement, in a line'),
    kind: z.enum(CONTRIBUTION_KINDS),
    area: z.enum(CONTRIBUTION_AREAS).describe('where in the app'),
  })
  .strict()
const voteInput = z
  .object({
    id: z.string().min(1),
    direction: z.union([z.literal(-1), z.literal(0), z.literal(1)]).describe('+1, -1, or 0 to take your vote back'),
  })
  .strict()

/** The person a proposal or vote belongs to: a human principal (the brain acting as one included). */
function personOf(ctx: ToolContext, what: string): string {
  if (ctx.principal.kind !== 'human') throw new ContributeError('forbidden', `A person ${what}, not the agent on its own.`)
  return ctx.principal.id
}

const STATUS_WORDS: Record<ContributionStatus, string> = {
  requested: 'back to requested',
  in_progress: 'in progress',
  shipped: 'shipped',
  declined: 'declined',
}

async function liveDeps(): Promise<ContributeDeps> {
  const { contributeDeps } = await import('./live')
  return contributeDeps()
}

async function liveActor(ctx: ToolContext): Promise<ContributeActor> {
  // An AI co-worker proposes and votes like a member and never manages the board.
  if (ctx.principal.kind === 'coworker') return { id: ctx.principal.id, kind: 'human', canManage: false }
  if (ctx.principal.kind !== 'human') return { id: ctx.principal.id, kind: 'agent', canManage: true }
  const { isUserAdmin } = await import('$lib/server/auth/user-role')
  return { id: ctx.principal.id, kind: 'human', canManage: await isUserAdmin(ctx.principal.id) }
}

/** Lists the central board's proposals, or null when this install is not the central board. */
export type HubLister = (statuses: readonly ContributionStatus[]) => Promise<HubProposalDto[]>

async function liveHub(): Promise<HubLister | null> {
  const { contributeHubActive, contributeHubDeps } = await import('./hub/live')
  if (!(await contributeHubActive())) return null
  const { listHubProposals } = await import('./hub/service')
  return async (statuses) => listHubProposals(await contributeHubDeps(), statuses)
}

const viewer = (ctx: ToolContext) => (ctx.principal.kind === 'human' ? ctx.principal.id : null)

export function createContributeTools(
  opts: {
    deps?: () => Promise<ContributeDeps>
    actor?: (ctx: ToolContext) => Promise<ContributeActor>
    hub?: () => Promise<HubLister | null>
  } = {},
): ToolDescriptor[] {
  const deps = opts.deps ?? liveDeps
  const actor = opts.actor ?? liveActor
  const hub = opts.hub ?? liveHub
  return [
    {
      name: 'contribute.list',
      module: CONTRIBUTE_MODULE_ID,
      summary:
        'List the improvements people in the company proposed for the app (the Make a wish board): id, title, kind (idea|bug|polish), area, status, net votes, author, note. Default: open ones (requested + in progress), most wanted first. On the central board install, for those who manage the board, `allInstalls` also lists what every eigenEnterprise install shared (no names: installId, remoteId, English summary, kind, area, status, score; details via contribute_hub.get).',
      auditClass: 'read',
      inputSchema: listInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = listInput.parse(input)
        const statuses: readonly ContributionStatus[] =
          i.status === 'open' ? OPEN_STATUSES : i.status === 'all' ? CONTRIBUTION_STATUSES : [i.status]
        const proposals = await listProposals(await deps(), viewer(ctx), statuses)
        // Like the "All installs" tab on /contribute: the central board only, for those who manage it.
        const listHub = await hub()
        if (listHub === null || !(await actor(ctx)).canManage) return { proposals }
        return { proposals, allInstalls: await listHub(statuses) }
      },
    },
    {
      name: 'contribute.get',
      module: CONTRIBUTE_MODULE_ID,
      summary: 'Read one proposal from the Make a wish board by id.',
      auditClass: 'read',
      inputSchema: getInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => getProposal(await deps(), viewer(ctx), getInput.parse(input).id),
    },
    {
      name: 'contribute.propose',
      module: CONTRIBUTE_MODULE_ID,
      summary: `Propose an improvement on the Make a wish board, as yourself (with your +1): title, kind (${CONTRIBUTION_KINDS.join('|')}) and area (${CONTRIBUTION_AREAS.join('|')}). Check contribute.list for an existing one first and vote on it instead.`,
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: { title?: string }) => `Proposed “${input.title ?? 'an improvement'}”`,
      inputSchema: proposeInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = proposeInput.parse(input)
        return shareProposal(await deps(), personOf(ctx, 'proposes an improvement'), i)
      },
    },
    {
      name: 'contribute.vote',
      module: CONTRIBUTE_MODULE_ID,
      summary: 'Vote on a proposal on the Make a wish board, as yourself: +1, -1, or 0 to take your vote back. Shipped proposals are closed.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (_input: unknown, output: ContributionDto | undefined) => `Voted on ${output ? `“${output.title}”` : 'a proposal'}`,
      inputSchema: voteInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = voteInput.parse(input)
        return voteProposal(await deps(), personOf(ctx, 'votes'), i.id, i.direction)
      },
    },
    {
      name: 'contribute.update',
      module: CONTRIBUTE_MODULE_ID,
      summary:
        "Move a proposal along and/or set the note people read on it: status in_progress when you pick it up, shipped when it is live, declined to take it off the board (requested restores it). Shipping stamps shipped_at and closes votes. note: string, or null to clear.",
      auditClass: 'mutate',
      activity: (input: z.infer<typeof updateInput>, output: ContributionDto | undefined) => {
        const what = output ? `“${output.title}”` : 'a proposal'
        return input.status ? `Marked ${what} ${STATUS_WORDS[input.status]}` : `Updated the note on ${what}`
      },
      inputSchema: updateInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = updateInput.parse(input)
        return updateProposal(await deps(), await actor(ctx), i.id, { status: i.status, note: i.note })
      },
    },
  ]
}
