import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { TRACES_MODULE_ID } from './manifest'
import { noticeGet, noticeSeen, sentGet, sentList, settingsGet, settingsSet, withdraw, TracesError, type TracesActor, type TracesDeps } from './service'

/**
 * traces.* kernel tools (plan/traces-phone-home.md §4): the same reads and acts as Settings →
 * Company → "Product signals" and "What was sent", so `ee tool run traces.sent_list` and the
 * agent see exactly what the page shows. The switch and withdrawing are the owner's.
 */

const listInput = z.object({ limit: z.number().int().min(1).max(500).default(50) }).strict()
const getInput = z.object({ id: z.uuid() }).strict()
const setInput = z
  .object({
    enabled: z.boolean(),
    withdraw: z.boolean().default(false).describe('when switching off: also delete everything sent from the hub'),
  })
  .strict()
const withdrawInput = z.object({ batch_id: z.uuid().nullable().default(null).describe('one batch, or null for everything sent') }).strict()

async function liveDeps(): Promise<TracesDeps> {
  const { tracesDeps } = await import('./live')
  return tracesDeps()
}

/** A person's company role, read now (kernel roles carry no `owner`: an owner is an admin to the registry). */
export type RoleOf = (userId: string) => Promise<string | null>

async function liveRoleOf(userId: string): Promise<string | null> {
  const { getUserRole } = await import('$lib/server/auth/user-role')
  return getUserRole(userId)
}

export function createTracesTools(opts: { deps?: () => Promise<TracesDeps>; roleOf?: RoleOf } = {}): ToolDescriptor[] {
  const deps = opts.deps ?? liveDeps
  const roleOf = opts.roleOf ?? liveRoleOf
  /** The acting person; the owner-only checks in service.ts use their real role. */
  const actorOf = async (ctx: ToolContext): Promise<TracesActor> => {
    if (ctx.principal.kind !== 'human') throw new TracesError('forbidden', 'A person (the owner) decides this, not the agent on its own.')
    return { id: ctx.principal.id, isOwner: (await roleOf(ctx.principal.id)) === 'owner' }
  }
  return [
    {
      name: 'traces.sent_list',
      module: TRACES_MODULE_ID,
      summary: 'List the batches of product signals (usage statistics, no content) this box sent or will send to the eigenEnterprise makers: id, state (pending|sent|failed|withdrawn), span count, withheld values, times.',
      auditClass: 'read',
      inputSchema: listInput,
      permission: { roles: ['owner', 'admin', 'agent'] },
      handler: async (_ctx, input) => sentList(await deps(), listInput.parse(input).limit),
    },
    {
      name: 'traces.sent_get',
      module: TRACES_MODULE_ID,
      summary: 'Read one batch of product signals exactly as sent (its JSON body), and the open values withheld from it because they could not be classified.',
      auditClass: 'read',
      inputSchema: getInput,
      permission: { roles: ['owner', 'admin', 'agent'] },
      handler: async (_ctx, input) => sentGet(await deps(), getInput.parse(input).id),
    },
    {
      name: 'traces.settings_get',
      module: TRACES_MODULE_ID,
      summary: 'Whether this box shares product signals with the makers (on by default), the only fields a signal has, the last send and the last problem.',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      permission: { roles: ['owner', 'admin', 'agent'] },
      handler: async () => settingsGet(await deps()),
    },
    {
      name: 'traces.settings_set',
      module: TRACES_MODULE_ID,
      summary: 'Owner: switch sharing product signals with the makers on or off. Off with withdraw=true also deletes everything sent from the hub.',
      auditClass: 'external',
      activity: (input: { enabled?: boolean }) => (input.enabled ? 'Switched sharing product signals on' : 'Switched sharing product signals off'),
      inputSchema: setInput,
      permission: { roles: ['owner', 'admin'] },
      handler: async (ctx, input) => settingsSet(await deps(), await actorOf(ctx), setInput.parse(input)),
    },
    {
      name: 'traces.withdraw',
      module: TRACES_MODULE_ID,
      summary: 'Owner: delete one sent batch (batch_id), or everything this box sent (null), from the makers’ hub.',
      auditClass: 'external',
      activity: (input: { batch_id?: string | null }) => (input.batch_id ? 'Withdrew a batch of product signals' : 'Withdrew every product signal sent'),
      inputSchema: withdrawInput,
      permission: { roles: ['owner', 'admin'] },
      handler: async (ctx, input) => withdraw(await deps(), await actorOf(ctx), withdrawInput.parse(input).batch_id),
    },
    {
      name: 'traces.notice_get',
      module: TRACES_MODULE_ID,
      summary: 'The one-time Needs you notice about product signals (what is shared, where the switch is) for the owner, until they mark it seen; null for everyone else.',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      permission: { roles: ['owner', 'admin', 'agent'] },
      handler: async (ctx) => noticeGet(await deps(), ctx.principal.kind === 'human' ? await actorOf(ctx) : { id: ctx.principal.id, isOwner: false }),
    },
    {
      name: 'traces.notice_seen',
      module: TRACES_MODULE_ID,
      summary: 'Owner: mark the one-time product signals notice seen ("Got it"), so it leaves Needs you.',
      auditClass: 'mutate',
      activity: () => 'Marked the product signals notice seen',
      inputSchema: z.object({}).strict(),
      permission: { roles: ['owner', 'admin'] },
      handler: async (ctx) => noticeSeen(await deps(), await actorOf(ctx)),
    },
  ]
}
