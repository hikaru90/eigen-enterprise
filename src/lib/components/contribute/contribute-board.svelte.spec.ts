import type { SentView, ShareItemView } from '../../../../modules/contribute/share/service'
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
    render(ContributeBoard, { proposals, canManage: false, sharing: null, client: { vote: vi.fn(), update: vi.fn(), sentPayload: vi.fn(), dontShare: vi.fn() }, onchanged: vi.fn(async () => {}) })
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
    render(ContributeBoard, { proposals, canManage: false, sharing: null, client: { vote, update: vi.fn(), sentPayload: vi.fn(), dontShare: vi.fn() }, onchanged })
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
    render(ContributeBoard, { proposals, canManage: true, sharing: null, client: { vote: vi.fn(), update, sentPayload: vi.fn(), dontShare: vi.fn() }, onchanged: vi.fn(async () => {}) })
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
    render(ContributeBoard, { proposals, canManage: false, sharing: null, client: { vote, update: vi.fn(), sentPayload: vi.fn(), dontShare: vi.fn() }, onchanged: vi.fn(async () => {}) })
    await page.getByRole('button', { name: 'Vote down' }).first().click()
    await expect.element(page.getByRole('alert')).toHaveTextContent('voting is closed')
  })

  it('the owner/admins see each proposal\'s sharing, the exact payload, and can stop one', async () => {
    const view = (state: ShareItemView['state'], over: Partial<ShareItemView> = {}): ShareItemView => ({ state, error: null, withdrawing: false, ...over })
    const sharing = { a: view('shared'), b: view('failed', { error: 'The central board answered HTTP 422' }), c: view('waiting'), d: view('not_shared') }
    const payload = { v: 1 as const, remote_id: 'a', summary: 'Dark theme for the whole app.', language: 'en', kind: 'idea' as const, area: 'everywhere' as const, status: 'requested' as const, score: 3, app_version: '0.5.9', created_day: '2026-11-01', shipped_day: null }
    const sentPayload = vi.fn(async (): Promise<SentView> => ({ sharing: view('shared'), payload, isOnHub: true, sentAt: '2026-11-01T10:00:00Z' }))
    const dontShare = vi.fn(async () => view('not_shared', { withdrawing: true }))
    const onchanged = vi.fn(async () => {})
    render(ContributeBoard, { proposals, canManage: true, sharing, client: { vote: vi.fn(), update: vi.fn(), sentPayload, dontShare }, onchanged })
    const states = page.getByTestId('contribute-share-state')
    await expect.element(states.first()).toHaveTextContent('Shared')
    await expect.element(states.nth(1)).toHaveTextContent('Failed')
    await expect.element(page.getByTestId('contribute-share-error')).toHaveTextContent('HTTP 422')

    await page.getByRole('button', { name: 'Show what was sent' }).first().click()
    expect(sentPayload).toHaveBeenCalledWith('a')
    await expect.element(page.getByTestId('contribute-sent')).toHaveTextContent('Exactly what the eigenEnterprise makers have')
    expect(JSON.parse(page.getByTestId('contribute-sent-payload').element().textContent!)).toEqual(payload)
    await page.getByRole('button', { name: 'Hide what was sent' }).click()
    expect(page.getByTestId('contribute-sent').elements()).toHaveLength(0)

    await page.getByRole('button', { name: "Don't share" }).first().click()
    expect(dontShare).toHaveBeenCalledWith('a')
    expect(onchanged).toHaveBeenCalled()
  })

  it('people who do not manage the board see no sharing', async () => {
    render(ContributeBoard, { proposals, canManage: false, sharing: null, client: { vote: vi.fn(), update: vi.fn(), sentPayload: vi.fn(), dontShare: vi.fn() }, onchanged: vi.fn(async () => {}) })
    await expect.element(page.getByTestId('contribute-tab-requested')).toBeInTheDocument()
    expect(page.getByTestId('contribute-sharing').elements()).toHaveLength(0)
  })
})
