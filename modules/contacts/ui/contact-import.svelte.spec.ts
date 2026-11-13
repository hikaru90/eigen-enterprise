import type { HistoryItem, ImportPreview } from '../types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import ContactHistory from './contact-history.svelte'
import ImportFile from './import-file.svelte'
import ImportPreviewView from './import-preview.svelte'

/** Import (vCard, CSV with the person's own column mapping) and the contact history, in a real browser. */

let submitted: number
const countSubmit = (e: Event) => {
  e.preventDefault()
  submitted += 1
}
beforeEach(() => {
  submitted = 0
  document.addEventListener('submit', countSubmit, true)
})
afterEach(() => document.removeEventListener('submit', countSubmit, true))

const sent = () => JSON.parse((document.querySelector('[data-testid="import-candidates"]') as HTMLInputElement).value) as Array<{ name: string }>
const chosen = () => JSON.parse((document.querySelector('[data-testid="import-chosen"]') as HTMLInputElement).value) as Array<{ name: string }>

async function pick(name: string, content: string) {
  await userEvent.upload(page.getByTestId('import-file-input'), new File([content], name))
}

describe('import-file.svelte', () => {
  it('a vCard is read as it is: the people are ready to check', async () => {
    render(ImportFile, {})
    await pick('people.vcf', 'BEGIN:VCARD\nVERSION:3.0\nFN:Mara Voss\nEMAIL:mara@northwind.example\nEND:VCARD\nBEGIN:VCARD\nFN:Jon Park\nEND:VCARD')
    await expect.element(page.getByTestId('import-check')).toHaveTextContent('Check 2 people')
    expect(sent().map((c) => c.name)).toEqual(['Mara Voss', 'Jon Park'])
    expect(submitted).toBe(0)
  })

  it('a CSV is not read until the person says what the columns hold (nothing is guessed from the headers)', async () => {
    render(ImportFile, {})
    await pick('people.csv', 'Name,E-Mail,Firma\nMara Voss,mara@northwind.example,Northwind\nJon Park,,Atelier')
    await expect.element(page.getByTestId('import-problems')).toHaveTextContent('Pick the column with the name')
    await expect.element(page.getByTestId('import-check')).toBeDisabled()
    for (const s of ['Name', 'E-Mail', 'Firma']) await expect.element(page.getByRole('combobox', { name: `What “${s}” holds` })).toHaveValue('ignore')

    await page.getByRole('combobox', { name: 'What “Name” holds' }).selectOptions('name')
    await page.getByRole('combobox', { name: 'What “E-Mail” holds' }).selectOptions('email')
    await page.getByRole('combobox', { name: 'What “Firma” holds' }).selectOptions('organisation')
    await expect.element(page.getByTestId('import-check')).toHaveTextContent('Check 2 people')
    expect(sent()).toEqual([
      expect.objectContaining({ name: 'Mara Voss', organisation: 'Northwind', channels: [{ type: 'email', value: 'mara@northwind.example' }] }),
      expect.objectContaining({ name: 'Jon Park', organisation: 'Atelier', channels: [] }),
    ])
  })

  it('the separator and the header row are the person’s choice', async () => {
    render(ImportFile, {})
    await pick('people.csv', 'Mara Voss;Northwind\nJon Park;Atelier')
    await page.getByRole('combobox', { name: 'Columns separated by' }).selectOptions(';')
    await page.getByText('The first row holds the column names').click()
    await page.getByRole('combobox', { name: 'What “Column 1” holds' }).selectOptions('name')
    await expect.element(page.getByTestId('import-check')).toHaveTextContent('Check 2 people')
  })

  it('another kind of file is refused', async () => {
    render(ImportFile, {})
    await pick('people.xlsx', 'binary')
    await expect.element(page.getByRole('alert')).toHaveTextContent('Pick a vCard (.vcf) or CSV (.csv) file.')
  })
})

describe('import-preview.svelte', () => {
  const contact = (name: string) => ({ name, organisation: null, title: null, channels: [], metHow: null, whyRelevant: null, tags: [] })
  const preview: ImportPreview = {
    rows: [
      { index: 0, status: 'new', contact: contact('Mara Voss') },
      { index: 1, status: 'duplicate', contact: contact('Jon Park'), email: 'jon@atelier.example', existing: { id: 'c1', name: 'Jon P.' } },
      { index: 2, status: 'new', contact: contact('Zoë') },
      { index: 3, status: 'invalid', name: '', error: 'Give the contact a name.' },
    ],
    counts: { new: 2, duplicate: 1, invalid: 1 },
  }

  it('new people are ticked; the known one and the broken row are reported, not imported; unticking leaves someone out', async () => {
    render(ImportPreviewView, { preview })
    await expect.element(page.getByTestId('import-counts')).toHaveTextContent('2 new · 1 already in your contacts · 1 can’t be imported')
    await expect.element(page.getByTestId('import-duplicate')).toHaveTextContent('jon@atelier.example is already in your contacts as Jon P.')
    await expect.element(page.getByTestId('import-invalid')).toHaveTextContent('Row 4 — Give the contact a name.')
    await expect.element(page.getByTestId('import-confirm')).toHaveTextContent('Import 2 contacts')
    expect(chosen().map((c) => c.name)).toEqual(['Mara Voss', 'Zoë'])

    await page.getByLabelText('Zoë').click()
    await expect.element(page.getByTestId('import-confirm')).toHaveTextContent('Import 1 contact')
    expect(chosen().map((c) => c.name)).toEqual(['Mara Voss'])
    expect(submitted).toBe(0)
  })
})

describe('contact-history.svelte', () => {
  const items: HistoryItem[] = [
    {
      kind: 'mail',
      id: 'm1',
      day: '2026-11-12',
      at: '2026-11-12T10:00:00Z',
      direction: 'received',
      via: { kind: 'mailbox', address: 'ana@co.example' },
      subject: 'The deck',
      snippet: 'Thanks!',
      href: '/m/email/inbox?box=b&m=m1',
    },
    {
      kind: 'logged',
      id: 'l1',
      day: '2026-11-11',
      at: '2026-11-11T10:00:00Z',
      by: 'Ana Lind',
      note: 'Coffee, liked the plan',
      answered: { on: '2026-11-10', step: 'Call' },
      next: { on: '2026-11-20', step: 'Send the deck' },
    },
    { kind: 'mail', id: 'c1', day: '2026-11-05', at: '2026-11-05T10:00:00Z', direction: 'sent', via: { kind: 'company', status: 'delivered' }, subject: 'Welcome', snippet: null, href: '/m/email/logs/c1' },
    { kind: 'added', id: 'x', day: '2026-11-01', at: '2026-11-01T10:00:00Z', by: 'Ana Lind' },
  ]

  it('shows everything newest first: mail (with a link to open it), how it went and what came next, when they were added', async () => {
    render(ContactHistory, { items, today: '2026-11-12', hasEmail: true })
    const rows = page.getByTestId('history-item')
    await expect.element(rows.nth(0)).toHaveTextContent(/today.*Mail from them to ana@co\.example.*The deck.*Thanks!/)
    await expect.element(page.getByRole('link', { name: 'The deck' })).toHaveAttribute('href', '/m/email/inbox?box=b&m=m1')
    await expect.element(rows.nth(1)).toHaveTextContent(/yesterday.*In touch.*Ana Lind.*Coffee, liked the plan.*Answered the follow-up 2026-11-10: Call.*Next: 2026-11-20: Send the deck/)
    await expect.element(rows.nth(2)).toHaveTextContent('The company sent them mail (delivered)')
    await expect.element(rows.nth(3)).toHaveTextContent('Added to Contacts by Ana Lind')
  })

  it('without an email address it says how to see mail here', async () => {
    render(ContactHistory, { items: [items[3]!], today: '2026-11-12', hasEmail: false })
    await expect.element(page.getByTestId('contact-history')).toHaveTextContent('Add an email address to see mail with them here.')
  })
})
