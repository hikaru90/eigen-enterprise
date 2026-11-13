import type { ContributionCheck, ContributionDto } from '../../../../modules/contribute/types'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import ContributeButton from './contribute-button.svelte'
import ContributeComposer from './contribute-composer.svelte'

vi.mock('$app/navigation', () => ({ invalidate: vi.fn(async () => {}) }))
vi.mock('$lib/contribute/client', () => ({
  contributeClient: () => ({ check: vi.fn(), share: vi.fn(), vote: vi.fn() }),
}))

const dto = (over: Partial<ContributionDto> = {}): ContributionDto => ({
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

function setup(check: ContributionCheck) {
  const client = {
    check: vi.fn(async () => check),
    share: vi.fn(async (d: { title: string; kind: ContributionDto['kind']; area: ContributionDto['area'] }) => dto({ id: 'new', title: d.title, kind: d.kind, area: d.area, score: 1, myVote: 1, own: true })),
    vote: vi.fn(async () => dto({ score: 4, myVote: 1 })),
  }
  const onchanged = vi.fn()
  render(ContributeComposer, { client, boardHref: '/contribute', onchanged })
  return { client, onchanged }
}

describe('contribute-composer.svelte', () => {
  it('Send runs the judge, then shares with its reading and says what it heard', async () => {
    const { client, onchanged } = setup({ kind: 'bug', area: 'messages', duplicateOf: null })
    const send = page.getByTestId('contribute-send')
    await expect.element(send).toBeDisabled()
    await expect.element(page.getByTestId('contribute-shared-note')).toHaveTextContent('shared with the eigenEnterprise makers, without names')
    await page.getByTestId('contribute-input').fill('  Threads lose my replies  ')
    await send.click()
    await expect.element(page.getByTestId('contribute-done')).toHaveTextContent('Thanks — it’s on the board.')
    await expect.element(page.getByTestId('contribute-done')).toHaveTextContent('Sounds like a bug in Messages')
    expect(client.check).toHaveBeenCalledWith('Threads lose my replies')
    expect(client.share).toHaveBeenCalledWith({ title: 'Threads lose my replies', kind: 'bug', area: 'messages' })
    expect(onchanged).toHaveBeenCalledTimes(1)
    await page.getByRole('button', { name: 'Propose another' }).click()
    await expect.element(page.getByTestId('contribute-input')).toHaveValue('')
  })

  it('a duplicate offers the chorus: vote for it instead', async () => {
    const { client, onchanged } = setup({ kind: 'idea', area: 'everywhere', duplicateOf: dto() })
    await page.getByTestId('contribute-input').fill('A dark theme')
    await page.getByTestId('contribute-send').click()
    await expect.element(page.getByTestId('contribute-duplicate')).toHaveTextContent('Dark mode')
    await expect.element(page.getByTestId('contribute-duplicate')).toHaveTextContent('3 votes · Requested')
    expect(client.share).not.toHaveBeenCalled()
    await page.getByRole('button', { name: 'Vote for it instead' }).click()
    await expect.element(page.getByTestId('contribute-done')).toHaveTextContent('Your vote is in.')
    expect(client.vote).toHaveBeenCalledWith('p1', 1)
    expect(onchanged).toHaveBeenCalledTimes(1)
  })

  it('a duplicate offers the chorus: mine’s different shares anyway', async () => {
    const { client } = setup({ kind: 'idea', area: 'everywhere', duplicateOf: dto() })
    await page.getByTestId('contribute-input').fill('Dark mode for the website only')
    await page.getByTestId('contribute-send').click()
    await page.getByRole('button', { name: 'Mine’s different' }).click()
    await expect.element(page.getByTestId('contribute-done')).toHaveTextContent('Thanks — it’s on the board.')
    expect(client.share).toHaveBeenCalledWith({ title: 'Dark mode for the website only', kind: 'idea', area: 'everywhere' })
  })

  it('a failed check keeps the draft and says why', async () => {
    const client = {
      check: vi.fn(async () => {
        throw new Error('No AI provider is set up')
      }),
      share: vi.fn(),
      vote: vi.fn(),
    }
    render(ContributeComposer, { client, boardHref: '/contribute' })
    await page.getByTestId('contribute-input').fill('Something')
    await page.getByTestId('contribute-send').click()
    await expect.element(page.getByRole('alert')).toHaveTextContent('No AI provider is set up')
    await expect.element(page.getByTestId('contribute-input')).toHaveValue('Something')
    expect(client.share).not.toHaveBeenCalled()
  })
})

describe('contribute-button.svelte', () => {
  it('a click outside closes the popover but keeps the draft (board bug: text gone after one stray click)', async () => {
    render(ContributeButton)
    await page.getByTestId('contribute-trigger').click()
    await page.getByTestId('contribute-input').fill('Let me speak my contributions')
    await userEvent.click(document.body, { position: { x: 2, y: 2 } })
    await expect.element(page.getByTestId('contribute-input')).not.toBeInTheDocument()
    await page.getByTestId('contribute-trigger').click()
    await expect.element(page.getByTestId('contribute-input')).toHaveValue('Let me speak my contributions')
  })
})
