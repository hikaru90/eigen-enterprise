import type { Actor, CallDto, CallsService, ScheduleResult } from './service'
import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { CallsError } from './errors'
import { CALLS_MODULE_ID } from './manifest'

/**
 * calls.* kernel tools. A person acts as themselves (their calls, their
 * conversations); any other principal (the agent) lists and ends only the
 * meetings it started and starts meetings only — it rings people, so
 * calls.start waits on the company's approval mode. No tool hands out a room
 * token: agents never join the media.
 * The rest are a person's own acts in their calls, the same service calls as
 * the New call dialog and the call screen (book a meeting with guests, invite
 * or remove a guest, the Company Brain's switch, sharing one's Brain answer,
 * the recap): a person (or the brain acting as them) only; an agent on its
 * own is refused.
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
const callInput = endInput
const emails = z
  .array(z.string().min(3))
  .min(1)
  .max(50)
  .describe('guests’ email addresses (people outside the company)')
const timeZone = z
  .string()
  .min(1)
  .describe('the host’s IANA time zone: the invitation shows times in it')
const scheduleInput = z
  .object({
    user_ids: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe('colleagues to invite (member ids)'),
    guests: emails.optional(),
    title: z.string().max(200).optional(),
    starts_at: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('ISO time; leave out for now'),
    duration_minutes: z.number().int().positive().optional().describe('default 60'),
    external_url: z
      .string()
      .url()
      .optional()
      .describe('another provider’s call link (Zoom, Teams, Meet …): no room of our own'),
    time_zone: timeZone,
  })
  .strict()
const inviteInput = z
  .object({ call_id: z.string().min(1), guests: emails, time_zone: timeZone })
  .strict()
const removeGuestInput = z
  .object({ call_id: z.string().min(1), guest_id: z.string().min(1) })
  .strict()
const brainInput = z.object({ call_id: z.string().min(1), on: z.boolean() }).strict()
const shareInput = z.object({ call_id: z.string().min(1), answer_id: z.string().min(1) }).strict()

export function actorOf(ctx: ToolContext): Actor {
  return ctx.principal.kind === 'human'
    ? { kind: 'user', userId: ctx.principal.id }
    : { kind: 'agent', id: ctx.principal.id }
}

/** A person's own act in their call: the agent on its own has none. */
function personOf(ctx: ToolContext): string {
  if (ctx.principal.kind !== 'human')
    throw new CallsError('forbidden', 'a person does this in their own calls')
  return ctx.principal.id
}

const invited = (out: unknown) =>
  (out as Partial<ScheduleResult> | undefined)?.invitations?.length ?? 0

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
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => ({
        calls: await (await service()).list(actorOf(ctx), listInput.parse(input).limit),
      }),
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
        return input.context_kind === 'meeting'
          ? 'Tried to start a meeting'
          : `Tried to start a call in ${input.context_kind} ${input.context_id ?? ''}`.trim()
      },
      inputSchema: startInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = startInput.parse(input)
        const call = await (
          await service()
        ).start(actorOf(ctx), {
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
      summary:
        'End a video call for everyone (only whoever started it may). Everyone still in it is disconnected.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof endInput>, output: unknown) => {
        const call = (output as { call?: CallDto } | undefined)?.call
        return call ? `Ended the call ${calledWhat(call)}` : `Tried to end call ${input.call_id}`
      },
      inputSchema: endInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => ({
        call: await (await service()).end(actorOf(ctx), endInput.parse(input).call_id),
      }),
    },
    {
      name: 'calls.schedule',
      module: CALLS_MODULE_ID,
      summary:
        'Book a meeting — now or later (starts_at), with a duration — with guests by email and/or colleagues, or on another provider’s link. Guests get a personal link by email (returned too, to pass on).',
      auditClass: 'external',
      approvalRisk: 'external',
      activity: (input: z.infer<typeof scheduleInput>, output: unknown) => {
        const call = (output as { call?: CallDto } | undefined)?.call
        return call
          ? `Booked a meeting: ${calledWhat(call)} (${invited(output)} guests)`
          : `Tried to book a meeting${input.title ? `: ${input.title}` : ''}`
      },
      inputSchema: scheduleInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = scheduleInput.parse(input)
        return (await service()).schedule(actorOf(ctx), {
          userIds: i.user_ids,
          guests: i.guests,
          title: i.title ?? null,
          startsAt: i.starts_at ? new Date(i.starts_at) : null,
          durationMinutes: i.duration_minutes ?? null,
          externalUrl: i.external_url ?? null,
          timeZone: i.time_zone,
        })
      },
    },
    {
      name: 'calls.invite_guests',
      module: CALLS_MODULE_ID,
      summary:
        'Invite more guests by email to a booked meeting you set up (an address already invited is skipped). Each gets a personal link.',
      auditClass: 'external',
      approvalRisk: 'external',
      activity: (input: z.infer<typeof inviteInput>, output: unknown) =>
        `Invited ${invited(output)} guests to call ${input.call_id}`,
      inputSchema: inviteInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = inviteInput.parse(input)
        return (await service()).inviteGuests(personOf(ctx), i.call_id, {
          guests: i.guests,
          timeZone: i.time_zone,
        })
      },
    },
    {
      name: 'calls.remove_guest',
      module: CALLS_MODULE_ID,
      summary:
        'Take back a guest’s link to a meeting you set up; a guest in the call is removed from it.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof removeGuestInput>) =>
        `Removed guest ${input.guest_id} from call ${input.call_id}`,
      inputSchema: removeGuestInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = removeGuestInput.parse(input)
        return { call: await (await service()).revokeGuest(personOf(ctx), i.call_id, i.guest_id) }
      },
    },
    {
      name: 'calls.brain_set',
      module: CALLS_MODULE_ID,
      summary:
        'Switch the Company Brain on (a member in the live call) or off (anyone in it) in a call. Everyone in the call sees it; it only listens.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof brainInput>) =>
        `Switched the Company Brain ${input.on ? 'on' : 'off'} in call ${input.call_id}`,
      inputSchema: brainInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = brainInput.parse(input)
        return { call: await (await service()).setBrain(personOf(ctx), i.call_id, i.on) }
      },
    },
    {
      name: 'calls.brain_share_answer',
      module: CALLS_MODULE_ID,
      summary:
        'Share one of your own Company Brain answers in a call with the colleagues in it (labelled: the Brain, asked by you).',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof shareInput>) =>
        `Shared a Company Brain answer with call ${input.call_id}`,
      inputSchema: shareInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = shareInput.parse(input)
        return {
          call: await (await service()).shareBrainAnswer(personOf(ctx), i.call_id, i.answer_id),
        }
      },
    },
    {
      name: 'calls.brain_recap',
      module: CALLS_MODULE_ID,
      summary:
        'After a call: a recap of what the Company Brain heard, for whoever switched it on — written now, shown to you, posted nowhere.',
      auditClass: 'read',
      inputSchema: callInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) =>
        (await service()).brainRecap(personOf(ctx), callInput.parse(input).call_id),
    },
  ]
}
