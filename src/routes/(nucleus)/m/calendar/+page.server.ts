import type { Actions, PageServerLoad } from './$types'
import { CalendarError } from '../../../../../modules/calendar/errors'
import { eventFormInput, todayIn } from '../../../../../modules/calendar/form'
import { calendarAction, calendarLoad, liveCalendarDeps, personActor } from '../../../../../modules/calendar/http'
import {
  createEvent,
  defaultVisibility,
  deleteEvent,
  freeBusy,
  listCalendar,
  setDefaultVisibility,
  updateEvent,
} from '../../../../../modules/calendar/service'
import { parseDay } from '../../../../../modules/calendar/time'
import { parseView, viewDays, viewHeading, viewRange } from '../../../../../modules/calendar/ui/layout'

/**
 * /m/calendar (plan/calendar.md K2): the person's own calendar by day, week
 * (the default) or month in their time zone (?view=, ?date=), the dialog's
 * create / change / delete, their default visibility, and colleagues'
 * availability for the people picked (?with=, free/busy only).
 */

const zoneList = (): string[] => [...Intl.supportedValuesOf('timeZone'), 'UTC'].filter((z, i, all) => all.indexOf(z) === i)

export const load: PageServerLoad = async ({ locals, url }) => {
  const actor = personActor(locals.user)
  return calendarLoad(async () => {
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
    if (rawDate !== null && !parseDay(rawDate)) throw new CalendarError('invalid', `date must be a day (YYYY-MM-DD), got ${JSON.stringify(rawDate)}`)
    const date = rawDate ?? today
    const range = viewRange(view, date, timeZone)
    // Availability: the day, or the week (a month view shows the week of its date).
    const availabilityDays = view === 'month' ? viewDays('week', date) : range.days
    const availabilityRange = viewRange(view === 'month' ? 'week' : view, date, timeZone)
    const selected = [...new Set(url.searchParams.getAll('with'))]
    const [occurrences, members, visibility, people] = await Promise.all([
      listCalendar(d, actor, { from: range.from.toISOString(), to: range.to.toISOString() }),
      d.members(),
      defaultVisibility(d, actor),
      selected.length === 0
        ? Promise.resolve([])
        : freeBusy(d, actor, { memberIds: selected, from: availabilityRange.from.toISOString(), to: availabilityRange.to.toISOString() }),
    ])
    return {
      view,
      date,
      today,
      heading: viewHeading(view, date),
      days: range.days,
      timeZone,
      occurrences,
      members: members.filter((m) => m.id !== actor.userId).map((m) => ({ id: m.id, name: m.name || m.email })),
      defaultVisibility: visibility,
      timeZones: zoneList(),
      availability: { selected, days: availabilityDays, people },
    }
  })
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
    return calendarAction('save', async () => {
      const { id, occurrenceStart, input } = eventFormInput(form)
      const d = await liveCalendarDeps()
      if (id === null) await createEvent(d, actor, input)
      else await updateEvent(d, actor, id, input, occurrenceStart ? { occurrenceStart } : {})
      return { action: 'save' as const, ok: true }
    })
  },
  /** The dialog's Delete: the event (a whole series), or one instance with occurrenceStart. */
  delete: async ({ locals, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    return calendarAction('delete', async () => {
      const occurrenceStart = text(form, 'occurrenceStart')
      await deleteEvent(await liveCalendarDeps(), actor, text(form, 'id'), occurrenceStart ? { occurrenceStart } : {})
      return { action: 'delete' as const, ok: true }
    })
  },
  /** What colleagues see of a new event by default. */
  preferences: async ({ locals, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    return calendarAction('preferences', async () => {
      await setDefaultVisibility(await liveCalendarDeps(), actor, text(form, 'defaultVisibility'))
      return { action: 'preferences' as const, ok: true }
    })
  },
}
