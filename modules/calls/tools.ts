import type { Actor, CallDto, CallsService } from './service'
import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { CALLS_MODULE_ID } from './manifest'

/**
 * calls.* kernel tools. A person acts as themselves (their calls, their
 * conversations); any other principal (the agent) lists and ends only the
 * meetings it started and starts meetings only — it rings people, so
 * calls.start waits on the company's approval mode. No tool hands out a room
 * token: agents never join the media.
 */

export type CallsToolDeps = { service: () => Promise<CallsService> }

const listInput = z.object({ limit: z.number().int().min(1).max(200).optional() }).strict()
const startInput = z
  .object({
    context_kind: z.enum(['dm', 'channel', 'meeting']),
    context_id: z.string().min(1).optional(),
    user_ids: z.array(z.string().min(1)).max(50).optional(),
    title: z.string().max(200).optional(),
  })
  .strict()
const endInput = z.object({ call_id: z.string().min(1) }).strict()

export function actorOf(ctx: ToolContext): Actor {
  return ctx.principal.kind === 'human' ? { kind: 'user', userId: ctx.principal.id } : { kind: 'agent', id: ctx.principal.id }
}

const calledWhat = (call: CallDto | undefined) => (call ? call.title : 'a call')

export function createCallsTools(opts: CallsToolDeps): ToolDescriptor[] {
  const { service } = opts
  return [
    {
      name: 'calls.list',
      module: CALLS_MODULE_ID,
      summary:
        'List video calls, newest first: a person’s calls (DMs, channels, meetings), or for the agent the meetings it started. Each with state, people and times.',
      auditClass: 'read',
      inputSchema: listInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => ({ calls: await (await service()).list(actorOf(ctx), listInput.parse(input).limit) }),
    },
    {
      name: 'calls.start',
      module: CALLS_MODULE_ID,
      summary:
        'Start a video call: context_kind "meeting" with user_ids to invite (and an optional title), or — for a person — "dm"/"channel" with context_id to ring that conversation. Rings everyone invited.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof startInput>, output: unknown) => {
        const call = (output as { call?: CallDto } | undefined)?.call
        if (call) return `Started a call: ${calledWhat(call)} (${call.participants.length} people)`
        return input.context_kind === 'meeting' ? 'Tried to start a meeting' : `Tried to start a call in ${input.context_kind} ${input.context_id ?? ''}`.trim()
      },
      inputSchema: startInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = startInput.parse(input)
        const call = await (await service()).start(actorOf(ctx), {
          contextKind: i.context_kind,
          contextId: i.context_id ?? null,
          userIds: i.user_ids,
          title: i.title ?? null,
        })
        return { call }
      },
    },
    {
      name: 'calls.end',
      module: CALLS_MODULE_ID,
      summary: 'End a video call for everyone (only whoever started it may). Everyone still in it is disconnected.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof endInput>, output: unknown) => {
        const call = (output as { call?: CallDto } | undefined)?.call
        return call ? `Ended the call ${calledWhat(call)}` : `Tried to end call ${input.call_id}`
      },
      inputSchema: endInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => ({ call: await (await service()).end(actorOf(ctx), endInput.parse(input).call_id) }),
    },
  ]
}
