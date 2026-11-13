import type { ContactDto, FollowUpDto } from '../types'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import ContactList from './contact-list.svelte'
import ContactsPrivacyNote from './contacts-privacy-note.svelte'
import FollowUpList from './follow-up-list.svelte'

const dto = (over: Partial<ContactDto> = {}): ContactDto => ({
  id: 'c1',
  name: 'Mara Voss',
  organisation: 'Northwind Capital',
  title: null,
  channels: [{ type: 'email', value: 'mara@northwind.example' }],
  metHow: null,
  whyRelevant: null,
  tags: ['investor'],
  lastContactedOn: null,
  nextFollowUpOn: null,
  nextStep: null,
  shared: false,
  own: true,
  createdByName: 'Ana Lind',
  canManage: true,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  ...over,
})

const followUp = (over: Partial<FollowUpDto>): FollowUpDto => ({
  ...dto(),
  nextFollowUpOn: '2026-11-12',
  due: 'today',
  daysFromToday: 0,
  ...over,
})

describe('follow-up-list.svelte (who to write to next)', () => {
  it('says when there is nothing to follow up', async () => {
    render(FollowUpList, { followUps: [], today: '2026-11-12' })
    await expect.element(page.getByTestId('follow-ups-empty')).toHaveTextContent(/next 14 days/)
  })

  it('shows overdue, today and coming up with the next step and a way to reach them', async () => {
    render(FollowUpList, {
      today: '2026-11-12',
      followUps: [
        followUp({ id: 'a', name: 'Late One', due: 'overdue', daysFromToday: -3, nextFollowUpOn: '2026-11-09', nextStep: 'Call back' }),
        followUp({ id: 'b', name: 'Today One' }),
        followUp({ id: 'c', name: 'Soon One', due: 'upcoming', daysFromToday: 4, nextFollowUpOn: '2026-11-16' }),
      ],
    })
    const when = page.getByTestId('follow-up-when')
    await expect.element(when.nth(0)).toHaveTextContent('Overdue · 3 days ago')
    await expect.element(when.nth(1)).toHaveTextContent('Today · today')
    await expect.element(when.nth(2)).toHaveTextContent('Coming up · in 4 days')
    await expect.element(page.getByTestId('follow-up-step')).toHaveTextContent('Call back')
    await expect.element(page.getByRole('link', { name: 'mara@northwind.example' }).first()).toHaveAttribute('href', 'mailto:mara@northwind.example')
    await expect.element(page.getByRole('link', { name: 'Late One' })).toHaveAttribute('href', '/m/email/people/a')
  })

  it('"Log contact" opens the log form for that row (today filled in); Cancel closes it', async () => {
    render(FollowUpList, { today: '2026-11-12', followUps: [followUp({ id: 'a', name: 'Mara Voss' })] })
    await page.getByRole('button', { name: 'Log contact' }).click()
    const form = page.getByRole('form', { name: 'Log a contact with Mara Voss' })
    await expect.element(form).toBeVisible()
    await expect.element(page.getByLabelText('In touch on')).toHaveValue('2026-11-12')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect.element(form).not.toBeInTheDocument()
  })

  it('a failed log reopens that row with the reason', async () => {
    render(FollowUpList, {
      today: '2026-11-12',
      followUps: [followUp({ id: 'a', name: 'Mara Voss' }), followUp({ id: 'b', name: 'Jon Park' })],
      logError: { id: 'b', message: 'The next follow-up can’t be before the day you were in touch.' },
    })
    await expect.element(page.getByRole('form', { name: 'Log a contact with Jon Park' })).toBeVisible()
    await expect.element(page.getByRole('alert')).toHaveTextContent(/can’t be before/)
    await expect.element(page.getByRole('form', { name: 'Log a contact with Mara Voss' })).not.toBeInTheDocument()
  })
})

describe('contact-list.svelte', () => {
  it('says who can see each contact and when you were last in touch', async () => {
    render(ContactList, {
      today: '2026-11-12',
      empty: 'No contacts yet.',
      contacts: [
        dto({ id: 'a', name: 'Mine', lastContactedOn: '2026-11-10' }),
        dto({ id: 'b', name: 'Bens', own: false, createdByName: 'Ben Ode' }),
        dto({ id: 'c', name: 'Ours', shared: true, own: false }),
      ],
    })
    const seen = page.getByTestId('contact-visibility')
    await expect.element(seen.nth(0)).toHaveTextContent('Private')
    await expect.element(seen.nth(1)).toHaveTextContent('Private to Ben Ode')
    await expect.element(seen.nth(2)).toHaveTextContent('Shared with the company')
    await expect.element(page.getByText('Last in touch 2 days ago')).toBeVisible()
  })

  it('shows the empty text', async () => {
    render(ContactList, { today: '2026-11-12', empty: 'No contacts yet.', contacts: [] })
    await expect.element(page.getByTestId('contacts-empty')).toHaveTextContent('No contacts yet.')
  })
})

describe('contacts-privacy-note.svelte', () => {
  it('states who can see a contact, what sharing does and what the agent sees', async () => {
    render(ContactsPrivacyNote)
    const note = page.getByRole('note', { name: 'Who can see your contacts' })
    await expect.element(note).toHaveTextContent(/private: only you, the company owner and admins/i)
    await expect.element(note).toHaveTextContent(/everyone in it can see and update it/i)
    await expect.element(note).toHaveTextContent(/assistant works for you, it sees what you see/i)
    await expect.element(note).toHaveTextContent(/approval setting/i)
  })
})
