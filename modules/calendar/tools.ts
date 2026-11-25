import { z } from 'zod'
import { actsAsMember } from '$lib/kernel/principals'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { addCall, removeCall } from './event-calls'
import { CALENDAR_MODULE_ID } from './manifest'
import { acceptProposal, dismissProposal, openProposals, type ProposalDeps } from './proposals'
import { reminderMinutes, setReminderMinutes } from './reminders'
import {
  createEvent,
  defaultVisibility,
  deleteEvent,
  freeBusy,
  listCalendar,
  setDefaultVisibility,
  showWeekNumbers,
  updateEvent,
  type Actor,
  type CalendarDeps,
  type EventInput,
} from './service'
import { CALENDAR_LIMITS, REMINDER_CHOICES, VISIBILITIES } from './types'

/**
 * calendar.* kernel tools: the agent's view of calendars and its hands in the
 * calendar of the person it works for. Every call runs through the calendar
 * service's rules:
 * - a person calls as themselves — also when the company brain acts for them
 *   (CB3: the principal IS the person), or through an agent key that belongs
 *   to them: their own calendar in full, colleagues only as availability;
 * - an agent principal that is no person has no calendar; it sees
 *   availability like any colleague (no private titles — the owner and
 *   admins get no more either) and writes nothing.
 * Every member reaches these tools (role 'member').
 * The writes (create / change / delete an event, a series or one occurrence;
 * accept or dismiss an appointment found in mail; the default visibility) are
 * the /m/calendar dialog's and the inbox's actions — the same service calls,
 * as the same person, never more; they wait on the company's approval mode.
 */

export type CalendarToolDeps = {
  deps?: () => Promise<CalendarDeps>
  /** For an agent principal: the member it IS (an API key of a person), or null (live: a member lookup). */
  agentPerson?: (ctx: ToolContext) => Promise<string | null>
  /** Appointments found in mail (calendar + proposals + the mail side). */
  proposalDeps?: () => Promise<ProposalDeps>
  now?: () => Date
}

const DEFAULT_DAYS = 7
const instant = z.string().min(1).describe('ISO date-time, e.g. 2026-11-16T00:00:00Z')
const rangeFields = {
  from: instant
    .optional()
    .describe('start of the range (inclusive); defaults to the start of today (UTC)'),
  to: instant
    .optional()
    .describe(
      `end of the range (exclusive); defaults to ${DEFAULT_DAYS} days after from; at most ${CALENDAR_LIMITS.rangeDays} days`,
    ),
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

const role = z.enum(['required', 'optional']).optional()
const guest = z.union([
  z.object({ member_id: z.string().min(1).describe('a colleague (member id)'), role }).strict(),
  z
    .object({
      email: z.string().min(3).describe('someone outside the company'),
      name: z.string().optional(),
      role,
    })
    .strict(),
])
const eventFields = {
  title: z.string().describe('the event title'),
  all_day: z
    .boolean()
    .describe(
      'all-day: start/end are days (YYYY-MM-DD, inclusive end); else wall times YYYY-MM-DDTHH:mm',
    ),
  start: z
    .string()
    .min(1)
    .describe('wall time YYYY-MM-DDTHH:mm in time_zone, or the first day of an all-day event'),
  end: z
    .string()
    .min(1)
    .describe('wall time YYYY-MM-DDTHH:mm in time_zone, or the last day of an all-day event'),
  time_zone: z.string().min(1).describe('IANA zone, e.g. Europe/Berlin'),
  location: z.string().optional(),
  notes: z.string().optional(),
  visibility: z
    .enum(VISIBILITIES)
    .optional()
    .describe('what colleagues see; defaults to the person’s default visibility'),
  rrule: z
    .string()
    .nullable()
    .optional()
    .describe('repeat rule (RRULE text, e.g. FREQ=WEEKLY;BYDAY=MO); null = not repeating'),
  attendees: z
    .array(guest)
    .max(CALENDAR_LIMITS.attendees)
    .optional()
    .describe(
      'guests: colleagues ({member_id}) or people outside ({email, name?}); replaces the guest list',
    ),
}
const eventInput = z.object(eventFields).strict()
const updateInput = z
  .object({
    id: z
      .string()
      .min(1)
      .describe('the event (an occurrence’s event.id, as calendar.list gives it)'),
    occurrence_start: instant
      .optional()
      .describe(
        'change only this occurrence of a series (its start, as calendar.list gives it); leave out for the whole event or series',
      ),
    title: eventFields.title.optional(),
    all_day: eventFields.all_day.optional(),
    start: eventFields.start.optional(),
    end: eventFields.end.optional(),
    time_zone: eventFields.time_zone.optional(),
    location: eventFields.location,
    notes: eventFields.notes,
    visibility: eventFields.visibility,
    rrule: eventFields.rrule,
    attendees: eventFields.attendees,
  })
  .strict()
const deleteInput = z
  .object({
    id: z.string().min(1),
    occurrence_start: instant
      .optional()
      .describe('delete only this occurrence of a series; leave out for the whole event or series'),
  })
  .strict()
const emptyInput = z.object({}).strict()
const proposalInput = z.object({ proposal_id: z.string().min(1) }).strict()
const acceptInput = z
  .object({
    proposal_id: z.string().min(1),
    event: eventInput
      .optional()
      .describe('the appointment as edited; leave out to accept it as found'),
  })
  .strict()
const visibilityInput = z.object({ visibility: z.enum(VISIBILITIES) }).strict()
const reminderInput = z
  .object({
    minutes: z
      .number()
      .int()
      .nullable()
      .describe(`minutes before each event: one of ${REMINDER_CHOICES.join(', ')} (0 = when it starts); null = no reminders`),
  })
  .strict()
const addCallInput = z
  .object({
    id: z.string().min(1).describe('the event (a timed event that does not repeat)'),
    call_id: z
      .string()
      .min(1)
      .optional()
      .describe('link a call the person is already in (calls.list) instead of booking one'),
    external_url: z
      .string()
      .url()
      .optional()
      .describe('book it on another provider’s link (Zoom, Teams, Meet …) instead of our own call server'),
  })
  .strict()
const eventIdInput = z.object({ id: z.string().min(1) }).strict()

type EventFields = Partial<z.infer<typeof eventInput>>

/** Tool fields → the service's EventInput (only what was sent; the service validates). */
function toEventInput(i: EventFields): EventInput {
  const out: EventInput = {}
  if (i.title !== undefined) out.title = i.title
  if (i.all_day !== undefined) out.allDay = i.all_day
  if (i.start !== undefined) out.start = i.start
  if (i.end !== undefined) out.end = i.end
  if (i.time_zone !== undefined) out.timeZone = i.time_zone
  if (i.location !== undefined) out.location = i.location
  if (i.notes !== undefined) out.notes = i.notes
  if (i.visibility !== undefined) out.visibility = i.visibility
  if (i.rrule !== undefined) out.rrule = i.rrule
  if (i.attendees !== undefined)
    out.attendees = i.attendees.map((g) =>
      'member_id' in g
        ? { memberId: g.member_id, role: g.role }
        : { email: g.email, name: g.name, role: g.role },
    )
  return out
}

async function liveDeps(): Promise<CalendarDeps> {
  const { calendarDeps } = await import('./live')
  return calendarDeps()
}

async function liveProposalDeps(): Promise<ProposalDeps> {
  const { proposalDeps } = await import('$lib/server/calendar/mail-proposals')
  return proposalDeps()
}

/** An agent principal that IS a person (their API key): that member's id, else null. */
async function liveAgentPerson(ctx: ToolContext): Promise<string | null> {
  const { getUserRole } = await import('$lib/server/auth/user-role')
  return (await getUserRole(ctx.principal.id)) ? ctx.principal.id : null
}

export function createCalendarTools(opts: CalendarToolDeps = {}): ToolDescriptor[] {
  const deps = opts.deps ?? liveDeps
  const agentPerson = opts.agentPerson ?? liveAgentPerson
  const proposalDeps = opts.proposalDeps ?? liveProposalDeps
  const clock = opts.now ?? (() => new Date())

  async function actorOf(ctx: ToolContext): Promise<Actor> {
    // A person — themselves, or the brain acting as them (CB3: the principal IS the person).
    // An AI co-worker is its own seat (plan/phase-ai-coworkers.md §3), never company-wide.
    if (actsAsMember(ctx.principal)) return { kind: 'user', userId: ctx.principal.id }
    const person = await agentPerson(ctx)
    return person ? { kind: 'user', userId: person } : { kind: 'agent', id: ctx.principal.id }
  }

  /** from/to together, or neither (today, UTC, for DEFAULT_DAYS days). */
  function rangeOf(i: { from?: string; to?: string }): { from: string; to: string } {
    if ((i.from === undefined) !== (i.to === undefined))
      throw new Error('Send from and to together, or neither.')
    if (i.from !== undefined && i.to !== undefined) return { from: i.from, to: i.to }
    const today = new Date(`${clock().toISOString().slice(0, 10)}T00:00:00Z`)
    return {
      from: today.toISOString(),
      to: new Date(today.getTime() + DEFAULT_DAYS * 86_400_000).toISOString(),
    }
  }

  return [
    {
      name: 'calendar.list',
      module: CALENDAR_MODULE_ID,
      summary:
        'The calendar of the person you work for: their events and the ones they are invited to, one entry per occurrence (recurring series expanded), with title, time, time zone, location, guests and visibility. Not other people’s calendars — use calendar.free_busy for colleagues.',
      auditClass: 'read',
      inputSchema: listInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const range = rangeOf(listInput.parse(input))
        return {
          ...range,
          occurrences: await listCalendar(await deps(), await actorOf(ctx), range),
        }
      },
    },
    {
      name: 'calendar.free_busy',
      module: CALENDAR_MODULE_ID,
      summary:
        'When colleagues are busy: per person, the blocks their events take — "busy" (with the title only for a company-visible event) or "out_of_office" (a private event). Use it to find a time that suits everyone.',
      auditClass: 'read',
      inputSchema: freeBusyInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = freeBusyInput.parse(input)
        const range = rangeOf(i)
        return {
          ...range,
          people: await freeBusy(await deps(), await actorOf(ctx), {
            memberIds: i.member_ids,
            ...range,
          }),
        }
      },
    },
    {
      name: 'calendar.proposals',
      module: CALENDAR_MODULE_ID,
      summary:
        'Appointments found agreed in the person’s own mail, still open: title, time, place, how to join, the people outside it is with, and the mail it came from. Accept with calendar.accept_proposal or dismiss with calendar.dismiss_proposal.',
      auditClass: 'read',
      inputSchema: emptyInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        emptyInput.parse(input)
        return { proposals: await openProposals(await proposalDeps(), await actorOf(ctx)) }
      },
    },
    {
      name: 'calendar.settings_get',
      module: CALENDAR_MODULE_ID,
      summary:
        'The calendar settings of the person you work for: the default visibility of new events, whether week numbers show, and how many minutes before an event their phone is reminded (null = no reminders).',
      auditClass: 'read',
      inputSchema: emptyInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        emptyInput.parse(input)
        const [d, actor] = [await deps(), await actorOf(ctx)]
        return {
          default_visibility: await defaultVisibility(d, actor),
          week_numbers: await showWeekNumbers(d, actor),
          reminder_minutes: await reminderMinutes(d, actor),
        }
      },
    },
    {
      name: 'calendar.create_event',
      module: CALENDAR_MODULE_ID,
      summary:
        'Add an event to the calendar of the person you work for — once or repeating (rrule), with colleagues and people outside as guests. Visibility defaults to their default.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: { title?: string }) => `Added "${input.title ?? ''}" to the calendar`,
      inputSchema: eventInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => ({
        event: await createEvent(
          await deps(),
          await actorOf(ctx),
          toEventInput(eventInput.parse(input)),
        ),
      }),
    },
    {
      name: 'calendar.update_event',
      module: CALENDAR_MODULE_ID,
      summary:
        'Change an event of the person you work for: the whole event or series, or with occurrence_start just that one occurrence of a series. Send only the fields that change (start, end, all_day and time_zone together).',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: { id?: string }) => `Changed calendar event ${input.id ?? ''}`.trim(),
      inputSchema: updateInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const { id, occurrence_start, ...fields } = updateInput.parse(input)
        const scope = occurrence_start ? { occurrenceStart: occurrence_start } : {}
        return {
          event: await updateEvent(
            await deps(),
            await actorOf(ctx),
            id,
            toEventInput(fields),
            scope,
          ),
        }
      },
    },
    {
      name: 'calendar.delete_event',
      module: CALENDAR_MODULE_ID,
      summary:
        'Delete an event of the person you work for — the whole event or series, or with occurrence_start one occurrence of a series.',
      auditClass: 'mutate',
      approvalRisk: 'destructive',
      activity: (input: { id?: string }) => `Deleted calendar event ${input.id ?? ''}`.trim(),
      inputSchema: deleteInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = deleteInput.parse(input)
        await deleteEvent(
          await deps(),
          await actorOf(ctx),
          i.id,
          i.occurrence_start ? { occurrenceStart: i.occurrence_start } : {},
        )
        return { deleted: i.id }
      },
    },
    {
      name: 'calendar.accept_proposal',
      module: CALENDAR_MODULE_ID,
      summary:
        'Accept an appointment found in the person’s mail (calendar.proposals): it goes on their calendar and the people outside get an invitation from their mailbox. Optionally with the event as edited.',
      auditClass: 'external',
      approvalRisk: 'external',
      activity: (input: { proposal_id?: string }) =>
        `Accepted the appointment ${input.proposal_id ?? ''} found in mail`.trim(),
      inputSchema: acceptInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = acceptInput.parse(input)
        return acceptProposal(
          await proposalDeps(),
          await actorOf(ctx),
          i.proposal_id,
          i.event ? toEventInput(i.event) : undefined,
        )
      },
    },
    {
      name: 'calendar.dismiss_proposal',
      module: CALENDAR_MODULE_ID,
      summary: 'Dismiss an appointment found in the person’s mail: nothing is added or sent.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: { proposal_id?: string }) =>
        `Dismissed the appointment ${input.proposal_id ?? ''} found in mail`.trim(),
      inputSchema: proposalInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = proposalInput.parse(input)
        await dismissProposal(await proposalDeps(), await actorOf(ctx), i.proposal_id)
        return { dismissed: i.proposal_id }
      },
    },
    {
      name: 'calendar.set_default_visibility',
      module: CALENDAR_MODULE_ID,
      summary:
        'What colleagues see of the person’s new events by default: company (title and time), busy, or private (out of office).',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: { visibility?: string }) =>
        `Set the default visibility of new events to ${input.visibility ?? ''}`.trim(),
      inputSchema: visibilityInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => ({
        visibility: await setDefaultVisibility(
          await deps(),
          await actorOf(ctx),
          visibilityInput.parse(input).visibility,
        ),
      }),
    },
    {
      name: 'calendar.set_reminder',
      module: CALENDAR_MODULE_ID,
      summary: `How many minutes before each of their events the person's phone gets a reminder (push): ${REMINDER_CHOICES.join(', ')} (0 = when it starts), or null for none. For an event with a call the reminder opens the call.`,
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: { minutes?: number | null }) =>
        input.minutes === null
          ? 'Turned calendar reminders off'
          : `Set calendar reminders to ${input.minutes ?? ''} minutes before`,
      inputSchema: reminderInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => ({
        minutes: await setReminderMinutes(
          await deps(),
          await actorOf(ctx),
          reminderInput.parse(input).minutes,
        ),
      }),
    },
    {
      name: 'calendar.add_call',
      module: CALENDAR_MODULE_ID,
      summary:
        'Put a video call on an event of the person you work for: books a meeting for the event’s time with its guests (colleagues join from the event; guests outside the company get the call link by email), or links a call they are in (call_id). Join from the event (event.joinUrl) or from its reminder. Timed events that don’t repeat only; while it has a call the event keeps its time.',
      auditClass: 'external',
      approvalRisk: 'external',
      activity: (input: { id?: string; call_id?: string }) =>
        input.call_id
          ? `Linked call ${input.call_id} to calendar event ${input.id ?? ''}`.trim()
          : `Booked a video call for calendar event ${input.id ?? ''}`.trim(),
      inputSchema: addCallInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = addCallInput.parse(input)
        return {
          event: await addCall(await deps(), await actorOf(ctx), i.id, {
            callId: i.call_id,
            externalUrl: i.external_url,
          }),
        }
      },
    },
    {
      name: 'calendar.remove_call',
      module: CALENDAR_MODULE_ID,
      summary:
        'Take the video call off an event of the person you work for. The meeting itself stays booked (calls.end ends it).',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: { id?: string }) =>
        `Removed the call from calendar event ${input.id ?? ''}`.trim(),
      inputSchema: eventIdInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => ({
        event: await removeCall(await deps(), await actorOf(ctx), eventIdInput.parse(input).id),
      }),
    },
  ]
}
