import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import MailboxesPage from './+page.svelte'

vi.mock('$app/paths', () => ({ base: '', resolve: (path: string) => path }))
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy: () => undefined }) }))

const box = {
  id: '11111111-1111-4111-8111-111111111111',
  address: 'alex.bueckni@acme.test',
  aliases: ['alex@acme.test'],
  kind: 'personal' as const,
  holder: 'Alex',
  displayName: null,
  disabled: false,
  messages: 3,
  unread: 1,
  sizeBytes: 2048,
}
const data = {
  mine: [],
  admin: { mailboxes: [box], members: [], groups: [], domains: [{ id: 'd-1', name: 'acme.test' }] },
}

describe('Email › Setup › Mailboxes rows', () => {
  it('says what an alias is, and opens change-address and delete forms that explain what happens', async () => {
    render(MailboxesPage, { data, form: null } as never)
    await expect.element(page.getByText('Also receives mail sent to')).toBeVisible()
    await expect.element(page.getByLabelText('New alias for alex.bueckni@acme.test')).not.toBeInTheDocument()

    await page.getByRole('button', { name: 'Change address' }).click()
    await expect.element(page.getByLabelText('New address for alex.bueckni@acme.test')).toBeVisible()
    await expect.element(page.getByText(/Mail sent to the old one stops arriving/)).toBeVisible()

    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect.element(page.getByLabelText('New address for alex.bueckni@acme.test')).not.toBeInTheDocument()
    const confirm = page.getByTestId('mailbox-delete-confirm')
    await expect.element(confirm).toHaveTextContent(/the 3 mails in it are deleted/)
    await expect.element(page.getByRole('button', { name: 'Delete for good' })).toBeVisible()

    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect.element(confirm).not.toBeInTheDocument()
  })
})
