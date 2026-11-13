import type { EventDraft } from '../form'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { eventFormInput, newDraft, NO_REPEAT } from '../form'
import EventDialog from './event-dialog.svelte'

const members = [
  { id: 'ben', name: 'Ben Ode' },
  { id: 'olga', name: 'Olga Owner' },
]
const timeZones = ['Europe/Berlin', 'Europe/London', 'UTC']

/** What the dialog's form would post, read the way the page action reads it. */
function posted() {
  const form = document.querySelector<HTMLFormElement>('[data-testid="event-form"]')
  if (!form) throw new Error('no event form')
  return eventFormInput(new FormData(form))
}

const seriesInstance: EventDraft = {
  ...newDraft({ day: '2026-11-16', time: '10:00', timeZone: 'Europe/Berlin', visibility: 'busy' }),
  id: 's1',
  occurrenceStart: '2026-11-16T09:00:00.000Z',
  inSeries: true,
  title: 'Standup',
  endTime: '10:30',
  series: { startDay: '2026-11-02', startTime: '10:00', endDay: '2026-11-02', endTime: '10:30' },
  repeat: { ...NO_REPEAT, freq: 'WEEKLY', days: ['MO'] },
  guests: ['ben'],
}

describe('event-dialog.svelte', () => {
  it('a new event: busy unless chosen otherwise, each choice says what colleagues see', async () => {
    render(EventDialog, {
      open: true,
      draft: newDraft({ day: '2026-11-16', time: '14:00', timeZone: 'Europe/Berlin', visibility: 'busy' }),
      members,
      timeZones,
    })
    await expect.element(page.getByRole('heading', { name: 'New event' })).toBeInTheDocument()
    await expect.element(page.getByRole('radio', { name: /^Busy/ })).toBeChecked()
    await expect.element(page.getByText('Colleagues see “Out of office” and the time.')).toBeInTheDocument()
    await expect.element(page.getByText('Colleagues see the title and time.')).toBeInTheDocument()
    await page.getByRole('textbox', { name: 'Title' }).fill('Call with Northwind')
    await page.getByRole('radio', { name: /^Private/ }).click()
    await page.getByRole('checkbox', { name: 'Ben Ode' }).click()
    expect(posted()).toEqual({
      id: null,
      occurrenceStart: null,
      input: {
        title: 'Call with Northwind',
        allDay: false,
        start: '2026-11-16T14:00',
        end: '2026-11-16T15:00',
        timeZone: 'Europe/Berlin',
        location: '',
        notes: '',
        visibility: 'private',
        rrule: null,
        attendees: [{ memberId: 'ben' }],
      },
    })
  })

  it('repeats weekly on the days picked, until a day', async () => {
    render(EventDialog, { open: true, draft: newDraft({ day: '2026-11-16', time: '09:00', timeZone: 'UTC', visibility: 'company' }), members, timeZones })
    await page.getByRole('textbox', { name: 'Title' }).fill('Standup')
    await page.getByRole('combobox', { name: 'Repeat' }).selectOptions('WEEKLY')
    await page.getByRole('checkbox', { name: 'Monday' }).click()
    await page.getByRole('checkbox', { name: 'Thursday' }).click()
    await page.getByRole('combobox', { name: 'Ends' }).selectOptions('on')
    await page.getByLabelText('Last day').fill('2026-12-31')
    expect(posted().input.rrule).toBe('FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20261231')
  })

  it('all day hides the times and sends days', async () => {
    render(EventDialog, { open: true, draft: newDraft({ day: '2026-11-19', time: null, timeZone: 'Europe/Berlin', visibility: 'busy' }), members, timeZones })
    await page.getByRole('textbox', { name: 'Title' }).fill('Away')
    await page.getByRole('checkbox', { name: 'All day' }).click()
    await expect.element(page.getByLabelText('Start time')).not.toBeInTheDocument()
    expect(posted().input).toMatchObject({ allDay: true, start: '2026-11-19', end: '2026-11-19' })
  })

  it('an instance of a repeating event: “this event” changes just it; “all events” shows the series’ time, repeat and guests', async () => {
    render(EventDialog, { open: true, draft: seriesInstance, members, timeZones })
    await expect.element(page.getByRole('radio', { name: 'This event' })).toBeChecked()
    await expect.element(page.getByLabelText('Starts')).toHaveValue('2026-11-16')
    expect(page.getByTestId('event-repeat').query()).toBeNull()
    expect(page.getByTestId('event-guests').query()).toBeNull()
    expect(posted()).toMatchObject({ id: 's1', occurrenceStart: '2026-11-16T09:00:00.000Z' })
    expect(posted().input).not.toHaveProperty('rrule')

    await page.getByRole('radio', { name: 'All events' }).click()
    await expect.element(page.getByLabelText('Starts')).toHaveValue('2026-11-02')
    await expect.element(page.getByTestId('event-repeat')).toBeInTheDocument()
    await expect.element(page.getByRole('checkbox', { name: 'Ben Ode' })).toBeChecked()
    expect(posted()).toMatchObject({ id: 's1', occurrenceStart: null, input: { start: '2026-11-02T10:00', rrule: 'FREQ=WEEKLY;BYDAY=MO' } })
  })

  it('deleting asks first, and names what goes', async () => {
    render(EventDialog, { open: true, draft: seriesInstance, members, timeZones })
    await page.getByRole('button', { name: 'Delete this event' }).click()
    await expect.element(page.getByText('Delete this event?')).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Yes, delete' })).toBeInTheDocument()
    await page.getByRole('button', { name: 'Keep it' }).click()
    await expect.element(page.getByRole('button', { name: 'Delete this event' })).toBeInTheDocument()
  })

  it('a guest sees someone else’s event read only', async () => {
    render(EventDialog, {
      open: true,
      draft: { ...seriesInstance, inSeries: false, canEdit: false, ownerName: 'Ana Lind', location: 'Room 2', guestLabels: ['Ben Ode', 'Mara Voss'] },
      members,
      timeZones,
    })
    await expect.element(page.getByRole('heading', { name: 'Event' })).toBeInTheDocument()
    await expect.element(page.getByText('On Ana Lind’s calendar — only they change it.')).toBeInTheDocument()
    await expect.element(page.getByTestId('event-readonly')).toHaveTextContent('Room 2')
    await expect.element(page.getByTestId('event-readonly')).toHaveTextContent('Ben Ode, Mara Voss')
    expect(page.getByTestId('event-form').query()).toBeNull()
  })
})
