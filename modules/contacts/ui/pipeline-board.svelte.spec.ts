import type { Pipeline, PipelineItem, PipelineReview, PipelineStage } from '../types'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import PipelineBoard from './pipeline-board.svelte'

const review = (over: Partial<PipelineReview> = {}): PipelineReview => ({
  daysFromToday: null,
  overdue: false,
  daysWaiting: null,
  staleWaiting: false,
  missingNextStep: false,
  needsReview: false,
  ...over,
})

const item = (id: string, name: string, stage: PipelineStage, over: Partial<PipelineItem> = {}): PipelineItem => ({
  id,
  name,
  organisation: null,
  title: null,
  channels: [],
  metHow: null,
  whyRelevant: null,
  tags: [],
  lastContactedOn: null,
  nextFollowUpOn: null,
  nextStep: null,
  stage,
  ownerId: 'ana',
  ownerName: 'Ana Lind',
  via: null,
  latestStatus: null,
  waitingSince: null,
  shared: true,
  own: true,
  createdByName: 'Ana Lind',
  canManage: true,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  review: review(),
  ...over,
})

function board(): Pipeline {
  return {
    today: '2026-11-20',
    groups: [
      {
        stage: 'next',
        items: [item('c1', 'Nina Next', 'next', { nextStep: 'Send the offer', via: 'email', latestStatus: 'Liked the deck', lastContactedOn: '2026-11-18' })],
      },
      {
        stage: 'waiting',
        items: [
          item('c2', 'Olli Old', 'waiting', { waitingSince: '2026-11-05', review: review({ daysWaiting: 15, staleWaiting: true, needsReview: true }) }),
          item('c3', 'Fia Fresh', 'waiting', { waitingSince: '2026-11-18', review: review({ daysWaiting: 2 }) }),
        ],
      },
      { stage: 'keep_in_touch', items: [] },
      { stage: 'inbox', items: [item('c4', 'Ida Inbox', 'inbox', { ownerId: null, ownerName: null, review: review({ needsReview: true }) })] },
    ],
    review: { waitingTooLong: 1, overdue: 0, nextWithoutStep: 0, inbox: 1, waitingDays: 7 },
    people: [
      { id: 'ana', name: 'Ana Lind' },
      { id: 'ben', name: 'Ben Ode' },
    ],
  }
}

describe('pipeline-board.svelte (Ony’s groups as GTD lists)', () => {
  it('shows the four lists in order with Ony’s columns', async () => {
    render(PipelineBoard, { pipeline: board(), onsave: vi.fn(async () => null) })
    await expect.element(page.getByRole('heading', { name: /1 · Our move — Next actions/ })).toBeVisible()
    await expect.element(page.getByRole('heading', { name: /2 · Waiting for a reply — Waiting for/ })).toBeVisible()
    await expect.element(page.getByRole('heading', { name: /3 · Keep in the loop — Tickler/ })).toBeVisible()
    await expect.element(page.getByRole('heading', { name: /4 · Not contacted yet — Inbox/ })).toBeVisible()
    const next = page.getByTestId('pipeline-group-next')
    for (const col of ['Who', 'Last contacted', 'Held by', 'Via', 'Latest status', 'Next step', 'Due', 'List']) {
      await expect.element(next.getByRole('columnheader', { name: col, exact: true })).toBeVisible()
    }
    await expect.element(page.getByTestId('pipeline-group-waiting').getByRole('columnheader', { name: 'Chase on' })).toBeVisible()
    await expect.element(page.getByRole('textbox', { name: 'Next step with Nina Next' })).toHaveValue('Send the offer')
    await expect.element(page.getByRole('textbox', { name: 'Latest status with Nina Next' })).toHaveValue('Liked the deck')
    await expect.element(page.getByRole('combobox', { name: 'How we are in touch with Nina Next' })).toHaveValue('email')
    await expect.element(page.getByRole('combobox', { name: 'Who holds Nina Next' })).toHaveValue('ana')
    await expect.element(page.getByRole('combobox', { name: 'Who holds Ida Inbox' })).toHaveValue('')
  })

  it('edits who holds it, how, the next step and the list in place: one field per save', async () => {
    const onsave = vi.fn(async () => null)
    render(PipelineBoard, { pipeline: board(), onsave })
    await page.getByRole('combobox', { name: 'Who holds Ida Inbox' }).selectOptions('ben')
    expect(onsave).toHaveBeenLastCalledWith('c4', { ownerId: 'ben' })
    await page.getByRole('combobox', { name: 'How we are in touch with Ida Inbox' }).selectOptions('linkedin')
    expect(onsave).toHaveBeenLastCalledWith('c4', { via: 'linkedin' })
    const step = page.getByRole('textbox', { name: 'Next step with Ida Inbox' })
    await step.fill('Write a first note')
    step.element().dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(onsave).toHaveBeenLastCalledWith('c4', { nextStep: 'Write a first note' }))
    await page.getByRole('combobox', { name: 'List for Ida Inbox' }).selectOptions('waiting')
    expect(onsave).toHaveBeenLastCalledWith('c4', { stage: 'waiting' })
  })

  it('a refused change shows on its row', async () => {
    render(PipelineBoard, { pipeline: board(), onsave: vi.fn(async () => 'That person is not in the company.') })
    await page.getByRole('combobox', { name: 'Who holds Ida Inbox' }).selectOptions('ben')
    await expect.element(page.getByRole('alert')).toHaveTextContent('That person is not in the company.')
  })

  it('weekly review: counts what needs a look, flags the long wait, and narrows to just that', async () => {
    render(PipelineBoard, { pipeline: board(), onsave: vi.fn(async () => null) })
    const counts = page.getByTestId('pipeline-review-counts')
    await expect.element(counts).toHaveTextContent('1 waiting longer than 7 days')
    await expect.element(counts).toHaveTextContent('1 in the inbox to process')
    await expect.element(page.getByTestId('pipeline-flags')).toHaveTextContent('Waiting 15 days')
    await expect.element(page.getByText('Fia Fresh')).toBeVisible()
    await page.getByRole('button', { name: 'Show only what needs a look' }).click()
    await expect.element(page.getByText('Olli Old')).toBeVisible()
    await expect.element(page.getByText('Ida Inbox')).toBeVisible()
    await expect.element(page.getByText('Fia Fresh')).not.toBeInTheDocument()
    await expect.element(page.getByText('Nina Next')).not.toBeInTheDocument()
    await page.getByRole('button', { name: 'Show everyone' }).click()
    await expect.element(page.getByText('Nina Next')).toBeVisible()
  })

  it('dragging a row onto another list moves it there', async () => {
    const onsave = vi.fn(async () => null)
    render(PipelineBoard, { pipeline: board(), onsave })
    const row = document.querySelector('[data-testid="pipeline-row"][data-id="c4"]')!
    const target = page.getByTestId('pipeline-group-keep_in_touch').element()
    const data = new DataTransfer()
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }))
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
    await vi.waitFor(() => expect(onsave).toHaveBeenCalledWith('c4', { stage: 'keep_in_touch' }))
  })

  it('"Log contact" opens the log form with where they are now', async () => {
    render(PipelineBoard, { pipeline: board(), onsave: vi.fn(async () => null) })
    await page.getByTestId('pipeline-group-inbox').getByRole('button', { name: 'Log contact' }).click()
    await expect.element(page.getByRole('combobox', { name: 'Where they are now' })).toHaveValue('')
  })
})
