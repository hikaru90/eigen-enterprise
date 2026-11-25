import type { EventDraft } from '../form'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { eventFormInput, newDraft, NO_REPEAT, proposalDraft } from '../form'
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
      proposalId: null,
      withCall: false,
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

  it('an appointment from mail: says nothing is added yet, posts the proposal, keeps the people from the mail as guests', async () => {
    render(EventDialog, {
      open: true,
      draft: proposalDraft(
        {
          id: 'p-1',
          state: 'open',
          title: 'Call with Mara Voss',
          start: '2026-11-19T14:00:00.000Z',
          end: '2026-11-19T14:30:00.000Z',
          timeZone: 'Europe/Berlin',
          localStart: '2026-11-19T15:00',
          localEnd: '2026-11-19T15:30',
          location: null,
          call: 'https://meet.example/abc',
          attendees: [{ email: 'mara@sender.example', name: 'Mara Voss' }],
          eventId: null,
          mail: { messageId: 'm-1', mailboxId: 'b-1', subject: 'Re: Call?', from: { name: 'Mara Voss', address: 'mara@sender.example' } },
        },
        'busy',
      ),
      members,
      timeZones,
    })
    await expect.element(page.getByRole('heading', { name: 'Appointment from mail' })).toBeInTheDocument()
    await expect.element(page.getByText('Not on your calendar yet. Saving adds it and sends the invitation to the guests outside the company.')).toBeInTheDocument()
    await expect.element(page.getByTestId('event-external-guest')).toHaveTextContent('Mara Voss <mara@sender.example>')
    await expect.element(page.getByRole('button', { name: 'Save and send invitation' })).toBeInTheDocument()
    expect(posted()).toMatchObject({
      id: null,
      proposalId: 'p-1',
      input: { title: 'Call with Mara Voss', start: '2026-11-19T15:00', end: '2026-11-19T15:30', timeZone: 'Europe/Berlin', location: 'https://meet.example/abc' },
    })
    expect(posted().input.attendees).toEqual([{ email: 'mara@sender.example', name: 'Mara Voss' }])
    await page.getByRole('button', { name: 'Remove' }).click()
    await expect.element(page.getByRole('button', { name: 'Save', exact: true })).toBeInTheDocument()
  })

  it('a failed save shows the plain sentence with agent instructions', async () => {
    render(EventDialog, {
      open: true,
      draft: newDraft({ day: '2026-11-16', time: '14:00', timeZone: 'Europe/Berlin', visibility: 'busy' }),
      members,
      timeZones,
      error: 'An event must end after it starts.',
      agent: { attempted: 'Saving an event in the calendar', code: 'CalendarError', nextSteps: [] },
    })
    await expect.element(page.getByTestId('event-error').getByRole('alert')).toHaveTextContent('An event must end after it starts.')
    await expect.element(page.getByRole('button', { name: 'Copy agent instructions' })).toBeVisible()
  })

  describe('a video call on the event (K3)', () => {
    const saved: EventDraft = {
      ...newDraft({ day: '2026-11-16', time: '10:00', timeZone: 'Europe/Berlin', visibility: 'busy' }),
      id: 'e1',
      title: 'Customer call',
      guests: ['ben'],
    }

    it('a new timed event can be saved “With a video call”; all day or repeating, it can’t', async () => {
      render(EventDialog, {
        open: true,
        draft: newDraft({ day: '2026-11-16', time: '14:00', timeZone: 'Europe/Berlin', visibility: 'busy' }),
        members,
        timeZones,
      })
      await page.getByRole('checkbox', { name: /With a video call/ }).click()
      expect(posted().withCall).toBe(true)
      await page.getByRole('combobox', { name: 'Repeat' }).selectOptions('WEEKLY')
      await expect.element(page.getByTestId('event-with-call')).not.toBeInTheDocument()
      await page.getByRole('combobox', { name: 'Repeat' }).selectOptions('none')
      await page.getByRole('checkbox', { name: 'All day' }).click()
      await expect.element(page.getByTestId('event-with-call')).not.toBeInTheDocument()
    })

    it('a saved event without a call offers “Add a video call” (posts the event)', async () => {
      render(EventDialog, { open: true, draft: saved, members, timeZones })
      const add = page.getByRole('button', { name: 'Add a video call' })
      await expect.element(add).toBeInTheDocument()
      const form = add.element().closest('form')!
      expect(form.getAttribute('action')).toBe('?/addCall')
      expect(new FormData(form).get('id')).toBe('e1')
    })

    it('an event with a call: Join goes to the call, Remove call takes it off, the time stays', async () => {
      render(EventDialog, { open: true, draft: { ...saved, callId: 'c1', joinUrl: '/calls/c1' }, members, timeZones })
      await expect.element(page.getByRole('link', { name: 'Join call' })).toHaveAttribute('href', '/calls/c1')
      const remove = page.getByRole('button', { name: 'Remove call' })
      expect(remove.element().closest('form')!.getAttribute('action')).toBe('?/removeCall')
      await expect.element(page.getByText(/To move the event, remove the call first/)).toBeInTheDocument()
      await expect.element(page.getByRole('button', { name: 'Add a video call' })).not.toBeInTheDocument()
    })

    it('a guest joins from someone else’s event too', async () => {
      render(EventDialog, {
        open: true,
        draft: { ...saved, canEdit: false, ownerName: 'Ben Ode', callId: 'c1', joinUrl: '/calls/c1' },
        members,
        timeZones,
      })
      await expect.element(page.getByRole('link', { name: 'Join call' })).toHaveAttribute('href', '/calls/c1')
      await expect.element(page.getByRole('button', { name: 'Remove call' })).not.toBeInTheDocument()
    })
  })
})
