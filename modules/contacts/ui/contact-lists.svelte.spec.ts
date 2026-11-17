import type { ContactDto } from '../types'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import ContactList from './contact-list.svelte'
import ContactsPrivacyNote from './contacts-privacy-note.svelte'

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
  stage: 'inbox',
  ownerId: 'ana',
  ownerName: 'Ana Lind',
  via: null,
  latestStatus: null,
  waitingSince: null,
  shared: false,
  own: true,
  createdByName: 'Ana Lind',
  canManage: true,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  ...over,
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
  it('behind a "?" button: states who can see a contact, what sharing does and what the agent sees', async () => {
    render(ContactsPrivacyNote)
    await expect.element(page.getByTestId('contacts-privacy-content')).not.toBeInTheDocument()
    await page.getByRole('button', { name: 'Who can see your contacts?' }).click()
    const note = page.getByTestId('contacts-privacy-content')
    await expect.element(note).toHaveTextContent(/private: only you, the company owner and admins/i)
    await expect.element(note).toHaveTextContent(/everyone in it can see and update it/i)
    await expect.element(note).toHaveTextContent(/assistant works for you, it sees what you see/i)
    await expect.element(note).toHaveTextContent(/approval setting/i)
  })
})
