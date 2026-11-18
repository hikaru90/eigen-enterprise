import type { ScheduleCall, ScheduleResult } from './client'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import NewCallForm from './new-call-form.svelte'

/** The New call dialog's form (proposal 844bab56): guests by email first, another provider's link second. */

const people = [
  { id: 'ben', name: 'Ben Example', email: 'ben@co.test', image: null },
  { id: 'cat', name: 'Cat Example', email: 'cat@co.test', image: null },
]

const result = (over: Partial<ScheduleResult> = {}): ScheduleResult =>
  ({
    call: { id: 'call-1', title: 'Kick-off', scheduledStart: '2026-11-18T10:00:00.000Z', externalUrl: null },
    invitations: [{ guestId: 'g1', email: 'kunde@example.org', url: 'https://os.test/join/tok-1', emailed: true, error: null }],
    mailConfigured: true,
    ...over,
  }) as ScheduleResult

function mount(over: Record<string, unknown> = {}) {
  const onschedule = vi.fn(async (_input: ScheduleCall) => result())
  const ondone = vi.fn()
  render(NewCallForm, { props: { people, ownCallsAvailable: true, onschedule, ondone, ...over } as never })
  return { onschedule, ondone }
}

const guests = () => page.getByLabelText('Guests (email)')

describe('NewCallForm', () => {
  it('guests by email come first; the other call link is there, labelled, below', async () => {
    mount()
    const form = page.getByTestId('new-call-form').element()
    const labels = [...form.querySelectorAll('label, legend')].map((l) => l.textContent?.trim())
    const guestsAt = labels.findIndex((t) => t?.startsWith('Guests (email)'))
    const otherAt = labels.findIndex((t) => t?.startsWith('Other call link (Zoom, Teams, Google Meet …)'))
    expect(guestsAt).toBeGreaterThanOrEqual(0)
    expect(otherAt).toBeGreaterThan(guestsAt)
    await expect.element(page.getByLabelText('Other call link (Zoom, Teams, Google Meet …)')).toBeVisible()
  })

  it('takes several addresses (comma, space or Enter) and flags the ones that are not emails', async () => {
    const { onschedule } = mount()
    await guests().fill('kunde@example.org, amt@behoerde.de nope')
    await userEvent.keyboard('{Enter}')
    await expect.element(page.getByTestId('new-call-guest').first()).toBeVisible()
    expect(page.getByTestId('new-call-guest').elements().map((e) => e.getAttribute('data-email'))).toEqual(['kunde@example.org', 'amt@behoerde.de', 'nope'])
    expect(page.getByTestId('new-call-guest').elements().map((e) => e.getAttribute('data-valid'))).toEqual(['true', 'true', 'false'])
    await page.getByTestId('new-call-submit').click()
    await expect.element(page.getByTestId('new-call-error')).toHaveTextContent('Not an email address: nope')
    expect(onschedule).not.toHaveBeenCalled()
    await page.getByRole('button', { name: 'Remove nope' }).click()
    await page.getByTestId('new-call-submit').click()
    expect(onschedule).toHaveBeenCalledTimes(1)
    expect(onschedule.mock.calls[0]![0]).toMatchObject({
      guests: ['kunde@example.org', 'amt@behoerde.de'],
      userIds: [],
      startsAt: null,
      durationMinutes: 60,
      externalUrl: null,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  })

  it('an address still in the field counts when submitting', async () => {
    const { onschedule } = mount()
    await guests().fill('kunde@example.org')
    await page.getByTestId('new-call-submit').click()
    expect(onschedule.mock.calls[0]![0].guests).toEqual(['kunde@example.org'])
  })

  it('nobody to invite: says so, sends nothing', async () => {
    const { onschedule } = mount()
    await page.getByTestId('new-call-submit').click()
    await expect.element(page.getByTestId('new-call-error')).toHaveTextContent('Add at least one guest or colleague.')
    expect(onschedule).not.toHaveBeenCalled()
  })

  it('later: a start time and a duration; colleagues and a title go along', async () => {
    const { onschedule } = mount()
    await guests().fill('kunde@example.org')
    await page.getByLabelText('Title (optional)').fill('Kick-off')
    await page.getByRole('checkbox', { name: 'Ben Example' }).click()
    await page.getByLabelText('Later').click()
    await page.getByLabelText('Starts').fill('2030-03-04T14:30')
    await page.getByLabelText('Duration').selectOptions('30')
    await expect.element(page.getByTestId('new-call-submit')).toHaveTextContent('Schedule')
    await page.getByTestId('new-call-submit').click()
    expect(onschedule.mock.calls[0]![0]).toMatchObject({
      userIds: ['ben'],
      title: 'Kick-off',
      startsAt: new Date('2030-03-04T14:30').toISOString(),
      durationMinutes: 30,
    })
  })

  it('another provider’s link is sent along when filled in', async () => {
    const { onschedule } = mount()
    await guests().fill('kunde@example.org')
    await page.getByLabelText('Other call link (Zoom, Teams, Google Meet …)').fill('https://zoom.us/j/123')
    await page.getByTestId('new-call-submit').click()
    expect(onschedule.mock.calls[0]![0].externalUrl).toBe('https://zoom.us/j/123')
  })

  it('without our call server only another provider’s link works, and it says so', async () => {
    const { onschedule } = mount({ ownCallsAvailable: false })
    await guests().fill('kunde@example.org')
    await page.getByTestId('new-call-submit').click()
    await expect.element(page.getByTestId('new-call-error')).toHaveTextContent(/Video calls are not set up on this server/)
    expect(onschedule).not.toHaveBeenCalled()
  })

  it('after scheduling: each guest link to copy, and whether it was emailed', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    const { ondone } = mount()
    await guests().fill('kunde@example.org')
    await page.getByTestId('new-call-submit').click()
    await expect.element(page.getByTestId('new-call-invitation')).toHaveTextContent('kunde@example.org')
    await expect.element(page.getByTestId('new-call-invitation')).toHaveTextContent('Emailed')
    await page.getByRole('button', { name: 'Copy link for kunde@example.org' }).click()
    expect(writeText).toHaveBeenCalledWith('https://os.test/join/tok-1')
    await page.getByTestId('new-call-done').click()
    expect(ondone).toHaveBeenCalled()
  })

  it('email not set up: "Email isn’t set up — copy the link instead"', async () => {
    mount({ onschedule: vi.fn(async () => result({ mailConfigured: false, invitations: [{ guestId: 'g1', email: 'kunde@example.org', url: 'https://os.test/join/tok-1', emailed: false, error: null }] })) })
    await guests().fill('kunde@example.org')
    await page.getByTestId('new-call-submit').click()
    await expect.element(page.getByTestId('new-call-mail-off')).toHaveTextContent('Email isn’t set up — copy the link instead.')
    await expect.element(page.getByTestId('new-call-invitation')).toHaveTextContent('Not emailed')
  })

  it('a failed send says why for that guest', async () => {
    mount({ onschedule: vi.fn(async () => result({ invitations: [{ guestId: 'g1', email: 'kunde@example.org', url: 'https://os.test/join/tok-1', emailed: false, error: 'SES said no' }] })) })
    await guests().fill('kunde@example.org')
    await page.getByTestId('new-call-submit').click()
    await expect.element(page.getByTestId('new-call-invitation')).toHaveTextContent('Not sent: SES said no')
  })

  it('a refusal from the server is shown and the form stays', async () => {
    mount({ onschedule: vi.fn(async () => Promise.reject(new Error('the start time is in the past'))) })
    await guests().fill('kunde@example.org')
    await page.getByTestId('new-call-submit').click()
    await expect.element(page.getByTestId('new-call-error')).toHaveTextContent('the start time is in the past')
    await expect.element(guests()).toBeVisible()
  })
})
