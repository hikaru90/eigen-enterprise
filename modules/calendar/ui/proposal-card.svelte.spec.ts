import type { ProposalDto } from '../types'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import ProposalCard from './proposal-card.svelte'

const proposal: ProposalDto = {
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
  attendees: [
    { email: 'mara@sender.example', name: 'Mara Voss' },
    { email: 'sam@sender.example', name: null },
  ],
  eventId: null,
  mail: { messageId: 'm-1', mailboxId: 'b-1', subject: 'Re: Kurzer Call?', from: { name: 'Mara Voss', address: 'mara@sender.example' } },
}

const form = (action: string) => document.querySelector<HTMLFormElement>(`form[action="${action}"]`)

describe('proposal-card.svelte', () => {
  it('an open proposal: what, when (in its zone), the call, who — and that nothing is added or sent before Accept', async () => {
    render(ProposalCard, { proposal, editHref: '/m/calendar?proposal=p-1' })
    const card = page.getByTestId('calendar-proposal')
    await expect.element(card.getByRole('heading', { name: 'Appointment in this mail' })).toBeVisible()
    await expect.element(card.getByText('Call with Mara Voss')).toBeVisible()
    await expect.element(card.getByText('Thursday, 19 November 2026, 15:00 – 15:30')).toBeVisible()
    await expect.element(card.getByText('(Europe/Berlin)')).toBeVisible()
    await expect.element(card.getByText('https://meet.example/abc')).toBeVisible()
    await expect.element(card.getByText('Mara Voss, sam@sender.example', { exact: true })).toBeVisible()
    await expect.element(card.getByText(/Nothing is on your calendar yet\. Accept adds it and sends an invitation to Mara Voss, sam@sender\.example/)).toBeVisible()
  })

  it('Accept and Dismiss post the proposal to the page; Edit goes to Calendar', async () => {
    render(ProposalCard, { proposal, editHref: '/m/calendar?proposal=p-1' })
    await expect.element(page.getByRole('button', { name: 'Accept' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Dismiss' })).toBeVisible()
    for (const action of ['?/acceptProposal', '?/dismissProposal']) {
      const f = form(action)
      expect(f?.method).toBe('post')
      expect(new FormData(f!).get('proposalId')).toBe('p-1')
    }
    await expect.element(page.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/m/calendar?proposal=p-1')
  })

  it('in Calendar: Edit opens the dialog in place, and the mail it came from is linked', async () => {
    const onedit = vi.fn()
    render(ProposalCard, { proposal, heading: 'From your mail', onedit, mailHref: '/m/email/inbox?m=m-1' })
    await expect.element(page.getByRole('heading', { name: 'From your mail' })).toBeVisible()
    await expect.element(page.getByRole('link', { name: 'Re: Kurzer Call?' })).toHaveAttribute('href', '/m/email/inbox?m=m-1')
    await page.getByRole('button', { name: 'Edit' }).click()
    expect(onedit).toHaveBeenCalledTimes(1)
  })

  it('accepted: says it is on the calendar and who was invited; no buttons', async () => {
    render(ProposalCard, { proposal: { ...proposal, state: 'accepted', eventId: 'e-1' }, calendarHref: '/m/calendar?date=2026-11-19' })
    await expect.element(page.getByTestId('calendar-proposal-accepted')).toHaveTextContent('Added to your calendar. The invitation went to Mara Voss, sam@sender.example.')
    await expect.element(page.getByRole('link', { name: 'Open in Calendar' })).toHaveAttribute('href', '/m/calendar?date=2026-11-19')
    expect(form('?/acceptProposal')).toBeNull()
    expect(form('?/dismissProposal')).toBeNull()
  })

  it('dismissed: shows nothing', async () => {
    render(ProposalCard, { proposal: { ...proposal, state: 'dismissed' } })
    expect(document.querySelector('[data-testid="calendar-proposal"]')).toBeNull()
  })
})
