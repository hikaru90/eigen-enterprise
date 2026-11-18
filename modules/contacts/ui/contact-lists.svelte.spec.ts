import type { ChangeSharing } from '../client'
import type { ContactDto, ShareChoices } from '../types'
import { describe, expect, it, vi } from 'vitest'
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
  sharedWith: [],
  sharedWithViewer: false,
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
        dto({
          id: 'd',
          name: 'Sales one',
          sharedWith: [{ kind: 'group', id: 'g', name: 'Sales' }],
        }),
      ],
    })
    const seen = page.getByTestId('contact-visibility')
    await expect.element(seen.nth(0)).toHaveTextContent('Private')
    await expect.element(seen.nth(1)).toHaveTextContent('Private to Ben Ode')
    await expect.element(seen.nth(2)).toHaveTextContent('Whole team')
    await expect.element(seen.nth(3)).toHaveTextContent('Shared with Sales')
    // Without sharing wired, no checkboxes.
    await expect.element(page.getByTestId('contact-select').first()).not.toBeInTheDocument()
    await expect.element(page.getByText('Last in touch 2 days ago')).toBeVisible()
  })

  it('shows the empty text', async () => {
    render(ContactList, { today: '2026-11-12', empty: 'No contacts yet.', contacts: [] })
    await expect.element(page.getByTestId('contacts-empty')).toHaveTextContent('No contacts yet.')
  })
})

describe('contact-list.svelte: selecting many', () => {
  const choices: ShareChoices = {
    people: [
      { id: 'ana', name: 'Ana Lind' },
      { id: 'ben', name: 'Ben Ode' },
    ],
    groups: [{ id: 'sales', name: 'Sales' }],
  }
  const contacts = [
    dto({ id: 'a', name: 'Alpha' }),
    dto({ id: 'b', name: 'Beta' }),
    dto({ id: 'c', name: 'Gamma', own: false, canManage: false }),
  ]

  function setup(answer: Awaited<ReturnType<ChangeSharing>>) {
    const change = vi.fn<ChangeSharing>().mockResolvedValue(answer)
    const onchanged = vi.fn()
    render(ContactList, {
      today: '2026-11-12',
      empty: 'None',
      contacts,
      sharing: { choices, change, onchanged },
    })
    return { change, onchanged }
  }

  it('select all picks every contact shown; the action bar counts them and shares them with the whole team in one call', async () => {
    const { change, onchanged } = setup({
      changed: ['a', 'b'],
      skipped: [{ id: 'c', name: 'Gamma', reason: 'not_yours' }],
    })
    await expect.element(page.getByTestId('contacts-action-bar')).not.toBeInTheDocument()
    await page.getByTestId('contacts-select-all').click()
    await expect.element(page.getByTestId('contacts-selected-count')).toHaveTextContent('3 selected')

    await page.getByTestId('contacts-share-with').click()
    await expect.element(page.getByTestId('share-confirm')).toBeDisabled()
    await page.getByTestId('share-team').click()
    await page.getByRole('checkbox', { name: 'Sales' }).click()
    await page.getByTestId('share-confirm').click()

    expect(change).toHaveBeenCalledTimes(1)
    expect(change).toHaveBeenCalledWith({
      action: 'share',
      ids: ['a', 'b', 'c'],
      targets: { team: true, userIds: [], groupIds: ['sales'] },
    })
    await expect
      .element(page.getByTestId('contacts-sharing-report'))
      .toHaveTextContent(/Changed 2 contacts\. Skipped 1 contact that isn’t yours: Gamma/)
    expect(onchanged).toHaveBeenCalledTimes(1)
    // The skipped one stays selected; the changed ones are cleared.
    await expect.element(page.getByTestId('contacts-selected-count')).toHaveTextContent('1 selected')
  })

  it('picks rows one by one, makes them private, and clears', async () => {
    const { change } = setup({ changed: ['b'], skipped: [] })
    await page.getByRole('checkbox', { name: 'Select Beta' }).click()
    await expect.element(page.getByTestId('contacts-selected-count')).toHaveTextContent('1 selected')
    await page.getByTestId('contacts-make-private').click()
    expect(change).toHaveBeenCalledWith({ action: 'private', ids: ['b'] })
    await expect.element(page.getByTestId('contacts-sharing-report')).toHaveTextContent('Changed 1 contact.')
    await expect.element(page.getByTestId('contacts-action-bar')).not.toBeInTheDocument()

    await page.getByRole('checkbox', { name: 'Select Alpha' }).click()
    await page.getByRole('button', { name: 'Clear' }).click()
    await expect.element(page.getByTestId('contacts-action-bar')).not.toBeInTheDocument()
  })

  it('a failed change says why and keeps the selection', async () => {
    const change = vi.fn<ChangeSharing>().mockRejectedValue(new Error('Choose the whole team, a person or a group to share with.'))
    render(ContactList, {
      today: '2026-11-12',
      empty: 'None',
      contacts,
      sharing: { choices, change, onchanged: vi.fn() },
    })
    await page.getByRole('checkbox', { name: 'Select Alpha' }).click()
    await page.getByTestId('contacts-make-private').click()
    await expect.element(page.getByRole('alert')).toHaveTextContent('Choose the whole team')
    await expect.element(page.getByTestId('contacts-selected-count')).toHaveTextContent('1 selected')
  })
})

describe('contacts-privacy-note.svelte', () => {
  it('behind a "?" button: states who can see a contact, what sharing does and what the agent sees', async () => {
    render(ContactsPrivacyNote)
    await expect.element(page.getByTestId('contacts-privacy-content')).not.toBeInTheDocument()
    await page.getByRole('button', { name: 'Who can see your contacts?' }).click()
    const note = page.getByTestId('contacts-privacy-content')
    await expect.element(note).toHaveTextContent(/private \(only you, the company owner and admins\)/i)
    await expect.element(note).toHaveTextContent(/whole team — everyone in the company, including people who join later/i)
    await expect.element(note).toHaveTextContent(/Your own choice wins over the company’s/i)
    await expect.element(note).toHaveTextContent(/Select several in the list/i)
    await expect.element(note).toHaveTextContent(/assistant works for you, it sees what you see/i)
    await expect.element(note).toHaveTextContent(/approval setting/i)
  })
})
