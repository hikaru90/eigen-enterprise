import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { CALENDAR_MODULE_ID } from './manifest'
import { freeBusy, listCalendar, type Actor, type CalendarDeps } from './service'
import { CALENDAR_LIMITS } from './types'

/**
 * calendar.* kernel tools (read-only): the agent's view of calendars. Every
 * call runs through the calendar service's visibility rules:
 * - a person calls as themselves;
 * - the agent working for a person (the signed-in person it is answering, or
 *   an agent key that belongs to a person) is that person: their own
 *   calendar in full, colleagues only as availability;
 * - the agent on its own has no calendar; it sees availability like any
 *   colleague (no private titles — the owner and admins get no more either).
 * Proposing an event (`calendar.propose_event`, approval-gated) is a later slice.
 */

export type CalendarToolDeps = {
  deps?: () => Promise<CalendarDeps>
  /** The person the agent works for, if any (live: the request's signed-in user, or a principal that is a person). */
  onBehalfOf?: (ctx: ToolContext) => Promise<string | null>
  now?: () => Date
}

const DEFAULT_DAYS = 7
const instant = z.string().min(1).describe('ISO date-time, e.g. 2026-11-16T00:00:00Z')
const rangeFields = {
  from: instant.optional().describe('start of the range (inclusive); defaults to the start of today (UTC)'),
  to: instant.optional().describe(`end of the range (exclusive); defaults to ${DEFAULT_DAYS} days after from; at most ${CALENDAR_LIMITS.rangeDays} days`),
}
const listInput = z.object(rangeFields).strict()
const freeBusyInput = z
  .object({
    member_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(CALENDAR_LIMITS.freeBusyMembers)
      .describe('the people (member ids, as members.list gives them)'),
    ...rangeFields,
  })
  .strict()

async function liveDeps(): Promise<CalendarDeps> {
  const { calendarDeps } = await import('./live')
  return calendarDeps()
}

async function liveOnBehalfOf(ctx: ToolContext): Promise<string | null> {
  const { tenantUserAsyncLocal } = await import('$lib/server/db/tenant-context')
  const signedIn = tenantUserAsyncLocal.getStore()
  if (signedIn) return signedIn
  const { getUserRole } = await import('$lib/server/auth/user-role')
  return (await getUserRole(ctx.principal.id)) ? ctx.principal.id : null
}

export function createCalendarTools(opts: CalendarToolDeps = {}): ToolDescriptor[] {
  const deps = opts.deps ?? liveDeps
  const onBehalfOf = opts.onBehalfOf ?? liveOnBehalfOf
  const clock = opts.now ?? (() => new Date())

  async function actorOf(ctx: ToolContext): Promise<Actor> {
    if (ctx.principal.kind === 'human') return { kind: 'user', userId: ctx.principal.id }
    const person = await onBehalfOf(ctx)
    return person ? { kind: 'user', userId: person } : { kind: 'agent', id: ctx.principal.id }
  }

  /** from/to together, or neither (today, UTC, for DEFAULT_DAYS days). */
  function rangeOf(i: { from?: string; to?: string }): { from: string; to: string } {
    if ((i.from === undefined) !== (i.to === undefined)) throw new Error('Send from and to together, or neither.')
    if (i.from !== undefined && i.to !== undefined) return { from: i.from, to: i.to }
    const today = new Date(`${clock().toISOString().slice(0, 10)}T00:00:00Z`)
    return { from: today.toISOString(), to: new Date(today.getTime() + DEFAULT_DAYS * 86_400_000).toISOString() }
  }

  return [
    {
      name: 'calendar.list',
      module: CALENDAR_MODULE_ID,
      summary:
        'The calendar of the person you work for: their events and the ones they are invited to, one entry per occurrence (recurring series expanded), with title, time, time zone, location, guests and visibility. Not other people’s calendars — use calendar.free_busy for colleagues.',
      auditClass: 'read',
      inputSchema: listInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const range = rangeOf(listInput.parse(input))
        return { ...range, occurrences: await listCalendar(await deps(), await actorOf(ctx), range) }
      },
    },
    {
      name: 'calendar.free_busy',
      module: CALENDAR_MODULE_ID,
      summary:
        'When colleagues are busy: per person, the blocks their events take — "busy" (with the title only for a company-visible event) or "out_of_office" (a private event). Use it to find a time that suits everyone.',
      auditClass: 'read',
      inputSchema: freeBusyInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = freeBusyInput.parse(input)
        const range = rangeOf(i)
        return { ...range, people: await freeBusy(await deps(), await actorOf(ctx), { memberIds: i.member_ids, ...range }) }
      },
    },
  ]
}
