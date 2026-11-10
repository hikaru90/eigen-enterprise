import type { ContributionDto } from '../../../../modules/contribute/types'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import ContributeBoard from './contribute-board.svelte'

const dto = (over: Partial<ContributionDto>): ContributionDto => ({
  id: 'p1',
  title: 'Dark mode',
  kind: 'idea',
  area: 'everywhere',
  status: 'requested',
  score: 3,
  myVote: 0,
  own: false,
  authorId: 'ana',
  authorName: 'Ana Lind',
  note: null,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  shippedAt: null,
  ...over,
})

const proposals = [
  dto({ id: 'a', title: 'Dark mode', score: 3 }),
  dto({ id: 'b', title: 'Typo on login', kind: 'polish', area: 'settings', score: 1, own: true, myVote: 1 }),
  dto({ id: 'c', title: 'Search in Drive', status: 'in_progress', note: 'Picked up — building it now.' }),
  dto({ id: 'd', title: 'Faster sign-in', status: 'shipped', shippedAt: '2026-11-05T10:00:00Z' }),
]

describe('contribute-board.svelte', () => {
  it('shows the tabs with counts and the requested proposals first', async () => {
    render(ContributeBoard, { proposals, canManage: false, client: { vote: vi.fn(), update: vi.fn() }, onchanged: vi.fn(async () => {}) })
    await expect.element(page.getByTestId('contribute-tab-requested')).toHaveTextContent('Requested 2')
    await expect.element(page.getByTestId('contribute-tab-in_progress')).toHaveTextContent('In progress 1')
    expect(page.getByTestId('contribute-row').elements()).toHaveLength(2)
    await expect.element(page.getByText('Polish · Settings · you')).toBeInTheDocument()
    await page.getByTestId('contribute-tab-in_progress').click()
    await expect.element(page.getByTestId('contribute-note')).toHaveTextContent('Picked up — building it now.')
    await page.getByTestId('contribute-tab-shipped').click()
    await expect.element(page.getByRole('button', { name: 'Vote up' })).toBeDisabled()
    expect(page.getByLabelText('Status').elements()).toHaveLength(0)
  })

  it('votes, takes a vote back, and reloads the board', async () => {
    const vote = vi.fn(async (id: string, direction: -1 | 0 | 1) => dto({ id, title: 'Dark mode', score: 3 + direction, myVote: direction }))
    const onchanged = vi.fn(async () => {})
    render(ContributeBoard, { proposals, canManage: false, client: { vote, update: vi.fn() }, onchanged })
    await page.getByRole('button', { name: 'Vote up' }).first().click()
    expect(vote).toHaveBeenCalledWith('a', 1)
    expect(onchanged).toHaveBeenCalled()
    // b is the person's own (+1): clicking up again takes it back
    await page.getByRole('button', { name: 'Vote up' }).nth(1).click()
    expect(vote).toHaveBeenLastCalledWith('b', 0)
  })

  it('the makers move a proposal along and leave a note', async () => {
    const update = vi.fn(async (id: string, patch: { status?: ContributionDto['status']; note?: string | null }) =>
      dto({ id, status: patch.status ?? 'requested', note: patch.note ?? null }),
    )
    render(ContributeBoard, { proposals, canManage: true, client: { vote: vi.fn(), update }, onchanged: vi.fn(async () => {}) })
    await page.getByLabelText('Status').first().selectOptions('In progress')
    expect(update).toHaveBeenCalledWith('a', { status: 'in_progress' })
    // the reload brings back the server's truth (unchanged props here): a is still Requested
    await page.getByRole('button', { name: 'Add a note' }).nth(1).click()
    await page.getByLabelText('Note').fill('We are on it')
    await page.getByRole('button', { name: 'Save note' }).click()
    expect(update).toHaveBeenLastCalledWith('b', { note: 'We are on it' })
  })

  it('a failed vote says why', async () => {
    const vote = vi.fn(async () => {
      throw new Error('this proposal has shipped — voting is closed')
    })
    render(ContributeBoard, { proposals, canManage: false, client: { vote, update: vi.fn() }, onchanged: vi.fn(async () => {}) })
    await page.getByRole('button', { name: 'Vote down' }).first().click()
    await expect.element(page.getByRole('alert')).toHaveTextContent('voting is closed')
  })
})
