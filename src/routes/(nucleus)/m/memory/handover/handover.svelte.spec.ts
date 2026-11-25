import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import type { HandoverEntryView, HandoverView } from '$lib/server/memory/handover/service'
import Handover from './handover.svelte'

const entry = (over: Partial<HandoverEntryView> = {}): HandoverEntryView => ({
  id: 'e1',
  handoverId: 'h1',
  date: '2026-11-25',
  topic: 'Office lease',
  sentence: 'The landlord offers two renewal options.',
  status: 'decision_needed',
  link: '/m/drive/file/abc',
  assignee: null,
  assignedTask: null,
  writtenVia: 'person',
  updatedAt: '2026-11-25T09:00:00.000Z',
  ...over,
})

const handover = (over: Partial<HandoverView> = {}): HandoverView => ({
  id: 'h1',
  title: 'Handover to Alex',
  owner: { id: 'ony', name: 'Ony' },
  subject: { id: 'alex', name: 'Alex' },
  canEdit: true,
  updatedAt: '2026-11-25T09:00:00.000Z',
  entries: [
    entry(),
    entry({ id: 'e2', date: '2026-11-20', topic: 'EXIST grant', sentence: 'The application went out.', status: 'for_info', link: null, assignee: { id: 'kim', name: 'Kim' }, assignedTask: { id: 't', status: 'open' }, writtenVia: 'brain' }),
  ],
  ...over,
})

const members = [
  { id: 'ony', name: 'Ony' },
  { id: 'alex', name: 'Alex' },
  { id: 'kim', name: 'Kim' },
]

describe('Memory › Handover', () => {
  it('offers a new handover and suggests the assistant while there are none', async () => {
    render(Handover, { handovers: [], members, userId: 'ony' })
    await expect.element(page.getByTestId('handover-new')).toBeVisible()
    await expect.element(page.getByTestId('handover-empty')).toHaveTextContent(/ask the assistant/)
  })

  it('shows entries newest first with the day, a status chip, the sentence and the detail link', async () => {
    render(Handover, { handovers: [handover()], members, userId: 'ony' })
    const rows = page.getByTestId('handover-entry')
    await expect.element(rows.first()).toHaveTextContent(/Office lease/)
    await expect.element(rows.first()).toHaveTextContent(/Decision needed/)
    await expect.element(rows.first()).toHaveTextContent(/The landlord offers two renewal options\./)
    await expect.element(page.getByTestId('handover-entry-link-e1')).toHaveAttribute('href', '/m/drive/file/abc')
    await expect.element(rows.nth(1)).toHaveTextContent(/For info/)
    await expect.element(rows.nth(1)).toHaveTextContent(/Assigned to Kim/)
    await expect.element(rows.nth(1)).toHaveTextContent(/kept current by the brain/)
    await expect.element(page.getByTestId('handover-h1')).toHaveTextContent(/Kept by Ony · for Alex/)
  })

  it('the owner gets the add form and each entry’s edit, assign and remove', async () => {
    render(Handover, { handovers: [handover()], members, userId: 'ony' })
    await expect.element(page.getByTestId('handover-add-h1')).toBeVisible()
    await expect.element(page.getByTestId('handover-entry-edit-e1')).toBeVisible()
    await expect.element(page.getByTestId('handover-entry-remove-e1')).toBeVisible()
    // An open assignment waits for its task: no second Assign on that entry.
    await expect.element(page.getByTestId('handover-entry-assign-e1')).toBeVisible()
    await expect.element(page.getByTestId('handover-entry-assign-e2')).not.toBeInTheDocument()
    await page.getByTestId('handover-entry-edit-e1').click()
    await expect.element(page.getByTestId('handover-entry-form-e1')).toBeVisible()
  })

  it('a colleague reads it all but gets no edit controls', async () => {
    render(Handover, { handovers: [handover({ canEdit: false })], members, userId: 'alex' })
    await expect.element(page.getByTestId('handover-entry').first()).toHaveTextContent(/Office lease/)
    await expect.element(page.getByTestId('handover-read-only-h1')).toHaveTextContent(/Only Ony changes this handover\./)
    await expect.element(page.getByTestId('handover-add-h1')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('handover-entry-edit-e1')).not.toBeInTheDocument()
  })
})
