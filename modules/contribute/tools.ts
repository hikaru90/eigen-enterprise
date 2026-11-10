import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { CONTRIBUTE_MODULE_ID } from './manifest'
import { getProposal, listProposals, updateProposal, type ContributeActor, type ContributeDeps } from './service'
import { CONTRIBUTION_NOTE_MAX_LENGTH, CONTRIBUTION_STATUSES, OPEN_STATUSES, type ContributionDto, type ContributionStatus } from './types'

/**
 * contribute.* kernel tools: how an agent picks up what people proposed
 * (in-app assistant, `ee contribute.list`). Read the board, then move a
 * proposal to in_progress with a note when work starts and to shipped when
 * it is live — people see both on the board.
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
  if (ctx.principal.kind !== 'human') return { id: ctx.principal.id, kind: 'agent', canManage: true }
  const { isUserAdmin } = await import('$lib/server/auth/user-role')
  return { id: ctx.principal.id, kind: 'human', canManage: await isUserAdmin(ctx.principal.id) }
}

const viewer = (ctx: ToolContext) => (ctx.principal.kind === 'human' ? ctx.principal.id : null)

export function createContributeTools(
  opts: { deps?: () => Promise<ContributeDeps>; actor?: (ctx: ToolContext) => Promise<ContributeActor> } = {},
): ToolDescriptor[] {
  const deps = opts.deps ?? liveDeps
  const actor = opts.actor ?? liveActor
  return [
    {
      name: 'contribute.list',
      module: CONTRIBUTE_MODULE_ID,
      summary:
        'List the improvements people in the company proposed for the app (the Contribute board): id, title, kind (idea|bug|polish), area, status, net votes, author, note. Default: open ones (requested + in progress), most wanted first.',
      auditClass: 'read',
      inputSchema: listInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = listInput.parse(input)
        const statuses: readonly ContributionStatus[] =
          i.status === 'open' ? OPEN_STATUSES : i.status === 'all' ? CONTRIBUTION_STATUSES : [i.status]
        return { proposals: await listProposals(await deps(), viewer(ctx), statuses) }
      },
    },
    {
      name: 'contribute.get',
      module: CONTRIBUTE_MODULE_ID,
      summary: 'Read one proposal from the Contribute board by id.',
      auditClass: 'read',
      inputSchema: getInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => getProposal(await deps(), viewer(ctx), getInput.parse(input).id),
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
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = updateInput.parse(input)
        return updateProposal(await deps(), await actor(ctx), i.id, { status: i.status, note: i.note })
      },
    },
  ]
}
