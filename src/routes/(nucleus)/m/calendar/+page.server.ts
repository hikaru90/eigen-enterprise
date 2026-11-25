import type { Actions, PageServerLoad } from './$types'
import { CalendarError } from '../../../../../modules/calendar/errors'
import {
  addCall,
  createEventWithCall,
  removeCall,
} from '../../../../../modules/calendar/event-calls'
import { eventFormInput, todayIn } from '../../../../../modules/calendar/form'
import {
  calendarAction,
  calendarLoad,
  liveCalendarDeps,
  personActor,
} from '../../../../../modules/calendar/http'
import {
  acceptProposal,
  dismissProposal,
  openProposals,
} from '../../../../../modules/calendar/proposals'
import { reminderMinutes, setReminderMinutes } from '../../../../../modules/calendar/reminders'
import {
  createEvent,
  defaultVisibility,
  deleteEvent,
  freeBusy,
  listCalendar,
  setDefaultVisibility,
  setShowWeekNumbers,
  showWeekNumbers,
  updateEvent,
} from '../../../../../modules/calendar/service'
import { parseDay } from '../../../../../modules/calendar/time'
import {
  parseView,
  viewDays,
  viewHeading,
  viewRange,
} from '../../../../../modules/calendar/ui/layout'

/**
 * /m/calendar (plan/calendar.md K2): the person's own calendar by day, week
 * (the default) or month in their time zone (?view=, ?date=), the dialog's
 * create / change / delete, their default visibility, and colleagues'
 * availability for the people picked (?with=, free/busy only).
 * K7: the appointments found in the person's mail, to accept, edit (the
 * dialog, opened with ?proposal=<id> from the mail) or dismiss.
 * K3: the person's reminder setting, and a video call on an event (add,
 * remove, or with a new event; Join is a link to the call).
 */

async function liveProposalDeps() {
  const { proposalDeps } = await import('$lib/server/calendar/mail-proposals')
  return proposalDeps()
}

const zoneList = (): string[] =>
  [...Intl.supportedValuesOf('timeZone'), 'UTC'].filter((z, i, all) => all.indexOf(z) === i)

export const load: PageServerLoad = async ({ locals, url }) => {
  const actor = personActor(locals.user)
  return calendarLoad('Opening the calendar', async () => {
    const d = await liveCalendarDeps()
    const { timeZoneFor } = await import('../../../../../modules/calendar/live')
    const timeZone = await timeZoneFor(actor.userId)
    let view
    try {
      view = parseView(url.searchParams.get('view'))
    } catch (err) {
      throw new CalendarError('invalid', err instanceof Error ? err.message : String(err))
    }
    const today = todayIn(timeZone)
    const rawDate = url.searchParams.get('date')
    if (rawDate !== null && !parseDay(rawDate))
      throw new CalendarError(
        'invalid',
        `date must be a day (YYYY-MM-DD), got ${JSON.stringify(rawDate)}`,
      )
    const date = rawDate ?? today
    const range = viewRange(view, date, timeZone)
    // Availability: the day, or the week (a month view shows the week of its date).
    const availabilityDays = view === 'month' ? viewDays('week', date) : range.days
    const availabilityRange = viewRange(view === 'month' ? 'week' : view, date, timeZone)
    const selected = [...new Set(url.searchParams.getAll('with'))]
    const [proposals, occurrences, members, visibility, weekNumbers, reminder, people] = await Promise.all([
      openProposals(await liveProposalDeps(), actor),
      listCalendar(d, actor, { from: range.from.toISOString(), to: range.to.toISOString() }),
      d.members(),
      defaultVisibility(d, actor),
      showWeekNumbers(d, actor),
      reminderMinutes(d, actor),
      selected.length === 0
        ? Promise.resolve([])
        : freeBusy(d, actor, {
            memberIds: selected,
            from: availabilityRange.from.toISOString(),
            to: availabilityRange.to.toISOString(),
          }),
    ])
    return {
      view,
      date,
      today,
      heading: viewHeading(view, date),
      days: range.days,
      timeZone,
      occurrences,
      members: members
        .filter((m) => m.id !== actor.userId)
        .map((m) => ({ id: m.id, name: m.name || m.email })),
      defaultVisibility: visibility,
      weekNumbers,
      reminderMinutes: reminder,
      timeZones: zoneList(),
      availability: { selected, days: availabilityDays, people },
      proposals,
      editProposal: editProposalOf(proposals, url.searchParams.get('proposal')),
    }
  })
}

/** ?proposal=<id> (Edit from the mail): one of the person's open proposals, else 404. */
function editProposalOf(proposals: Array<{ id: string }>, id: string | null): string | null {
  if (id === null) return null
  if (!proposals.some((p) => p.id === id))
    throw new CalendarError(
      'not_found',
      'This appointment is no longer open: it was accepted or dismissed.',
    )
  return id
}

const text = (form: FormData, key: string): string => {
  const v = form.get(key)
  return typeof v === 'string' ? v : ''
}

export const actions: Actions = {
  /** The dialog's Save: a new event, a whole event or series, or one instance of a series. */
  save: async ({ locals, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    return calendarAction('save', 'Saving an event in the calendar', async () => {
      const { id, occurrenceStart, proposalId, withCall, input } = eventFormInput(form)
      // An appointment from mail, edited: Save accepts it (the event + the invitation).
      if (proposalId !== null) {
        const out = await acceptProposal(await liveProposalDeps(), actor, proposalId, input)
        return { action: 'save' as const, ok: true, invited: out.invited }
      }
      const d = await liveCalendarDeps()
      if (id === null && withCall) await createEventWithCall(d, actor, input, {})
      else if (id === null) await createEvent(d, actor, input)
      else await updateEvent(d, actor, id, input, occurrenceStart ? { occurrenceStart } : {})
      return { action: 'save' as const, ok: true }
    })
  },
  /** The dialog's Delete: the event (a whole series), or one instance with occurrenceStart. */
  delete: async ({ locals, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    return calendarAction('delete', 'Deleting an event in the calendar', async () => {
      const occurrenceStart = text(form, 'occurrenceStart')
      await deleteEvent(
        await liveCalendarDeps(),
        actor,
        text(form, 'id'),
        occurrenceStart ? { occurrenceStart } : {},
      )
      return { action: 'delete' as const, ok: true }
    })
  },
  /** An appointment from mail as found: the event + the invitation. */
  acceptProposal: async ({ locals, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    return calendarAction(
      'acceptProposal',
      'Accepting an appointment found in a mail',
      async () => {
        const out = await acceptProposal(await liveProposalDeps(), actor, text(form, 'proposalId'))
        return { action: 'acceptProposal' as const, ok: true, invited: out.invited }
      },
    )
  },
  dismissProposal: async ({ locals, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    return calendarAction(
      'dismissProposal',
      'Dismissing an appointment found in a mail',
      async () => {
        await dismissProposal(await liveProposalDeps(), actor, text(form, 'proposalId'))
        return { action: 'dismissProposal' as const, ok: true }
      },
    )
  },
  /** What colleagues see of a new event by default. */
  preferences: async ({ locals, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    return calendarAction(
      'preferences',
      'Saving the default visibility of new events',
      async () => {
        await setDefaultVisibility(await liveCalendarDeps(), actor, text(form, 'defaultVisibility'))
        return { action: 'preferences' as const, ok: true }
      },
    )
  },
  /** The reminder setting: minutes before each event, or off (K3). */
  reminder: async ({ locals, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    return calendarAction('reminder', 'Saving the calendar reminder setting', async () => {
      await setReminderMinutes(await liveCalendarDeps(), actor, text(form, 'reminderMinutes'))
      return { action: 'reminder' as const, ok: true }
    })
  },
  /** The dialog's "Add a video call": booked for the event's time with its guests (K3). */
  addCall: async ({ locals, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    return calendarAction('addCall', 'Adding a video call to an event', async () => {
      await addCall(await liveCalendarDeps(), actor, text(form, 'id'), {})
      return { action: 'addCall' as const, ok: true }
    })
  },
  /** The dialog's "Remove call" (the meeting itself stays booked). */
  removeCall: async ({ locals, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    return calendarAction('removeCall', 'Removing the video call from an event', async () => {
      await removeCall(await liveCalendarDeps(), actor, text(form, 'id'))
      return { action: 'removeCall' as const, ok: true }
    })
  },
  /** The "Week numbers" switch by the view picker (Contribute 9ae58a4e): on or off. */
  weekNumbers: async ({ locals, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    return calendarAction('weekNumbers', 'Switching week numbers in the calendar', async () => {
      await setShowWeekNumbers(await liveCalendarDeps(), actor, text(form, 'weekNumbers'))
      return { action: 'weekNumbers' as const, ok: true }
    })
  },
}
