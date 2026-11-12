import type { ContactDto } from '../types'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import ContactForm from './contact-form.svelte'

const contact = (over: Partial<ContactDto> = {}): ContactDto => ({
  id: 'c1',
  name: 'Mara Voss',
  organisation: 'Northwind Capital',
  title: 'Partner',
  channels: [{ type: 'linkedin', value: 'https://www.linkedin.com/in/mara' }],
  metHow: 'Founders breakfast',
  whyRelevant: 'Leads seed rounds',
  tags: ['investor', 'seed round'],
  lastContactedOn: '2026-11-01',
  nextFollowUpOn: '2026-11-20',
  nextStep: 'Send the deck',
  shared: false,
  own: true,
  createdByName: 'Ana Lind',
  canManage: true,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  ...over,
})

describe('contact-form.svelte', () => {
  it('offers the default tags (partner, customer, funder, investor, production) and one empty channel to start', async () => {
    render(ContactForm, { submitLabel: 'Add contact', offerShare: true })
    for (const tag of ['partner', 'customer', 'funder', 'investor', 'production']) {
      await expect.element(page.getByRole('checkbox', { name: tag })).not.toBeChecked()
    }
    await expect.element(page.getByRole('textbox', { name: 'Channel 1' })).toHaveValue('')
    await expect.element(page.getByRole('combobox', { name: 'Channel 1 type' })).toHaveValue('email')
    await expect.element(page.getByTestId('contact-share-now')).not.toBeChecked()
    await expect.element(page.getByText(/only you, the company owner and admins/i)).toBeVisible()
  })

  it('edits an existing contact: its values, its own tags checked, its channels', async () => {
    render(ContactForm, { contact: contact(), suggestedTags: ['printing'], submitLabel: 'Save', action: '?/save' })
    await expect.element(page.getByLabelText('Name')).toHaveValue('Mara Voss')
    await expect.element(page.getByLabelText('Role or title')).toHaveValue('Partner')
    await expect.element(page.getByRole('checkbox', { name: 'investor' })).toBeChecked()
    await expect.element(page.getByRole('checkbox', { name: 'seed round' })).toBeChecked()
    await expect.element(page.getByRole('checkbox', { name: 'printing' })).not.toBeChecked()
    await expect.element(page.getByRole('combobox', { name: 'Channel 1 type' })).toHaveValue('linkedin')
    await expect.element(page.getByLabelText('Next follow-up')).toHaveValue('2026-11-20')
    await expect.element(page.getByTestId('contact-share-now')).not.toBeInTheDocument()
  })

  it('adds and removes channels; removing the last leaves one empty row', async () => {
    render(ContactForm, { contact: contact(), submitLabel: 'Save' })
    await page.getByRole('button', { name: 'Add a channel' }).click()
    await expect.element(page.getByRole('textbox', { name: 'Channel 2' })).toBeVisible()
    await page.getByRole('textbox', { name: 'Channel 2' }).fill('+49 30 1234')
    await page.getByRole('button', { name: 'Remove channel 1' }).click()
    await expect.element(page.getByRole('textbox', { name: 'Channel 1' })).toHaveValue('+49 30 1234')
    await page.getByRole('button', { name: 'Remove channel 1' }).click()
    await expect.element(page.getByRole('textbox', { name: 'Channel 1' })).toHaveValue('')
    expect(page.getByTestId('channel-row').elements()).toHaveLength(1)
  })

  it('shows the server’s refusal', async () => {
    render(ContactForm, { submitLabel: 'Add contact', error: 'Give the contact a name.' })
    await expect.element(page.getByRole('alert')).toHaveTextContent('Give the contact a name.')
  })
})
