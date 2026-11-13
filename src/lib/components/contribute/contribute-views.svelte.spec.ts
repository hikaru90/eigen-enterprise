import type { HubProposalDto } from '../../../../modules/contribute-hub/types'
import type { ContributionDto } from '../../../../modules/contribute/types'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import ContributeViews from './contribute-views.svelte'

const local: ContributionDto = {
  id: 'p1',
  title: 'Dark mode please, Ana wants it',
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
}

const hub = (over: Partial<HubProposalDto>): HubProposalDto => ({
  installId: '11111111-1111-4111-8111-111111111111',
  remoteId: 'r1',
  summary: 'Add a dark mode to the whole app',
  language: 'de',
  kind: 'idea',
  area: 'everywhere',
  status: 'requested',
  score: 2,
  appVersion: '0.6.0',
  createdDay: '2026-11-12',
  shippedDay: null,
  updatedAt: '2026-11-13T10:00:00Z',
  receivedAt: '2026-11-13T10:00:00Z',
  ...over,
})

const base = { proposals: [local], canManage: true, client: { vote: vi.fn(), update: vi.fn() }, onchanged: vi.fn(async () => {}) }

describe('contribute-views.svelte', () => {
  it('without the hub (module off, or not an admin) there is only the company board', async () => {
    render(ContributeViews, { ...base, hub: null })
    await expect.element(page.getByTestId('contribute-board')).toBeInTheDocument()
    expect(page.getByRole('tab', { name: 'All installs' }).elements()).toHaveLength(0)
  })

  it('on the hub, "All installs" groups shared proposals by status, kind and area with install count and summed score; no votes, no authors', async () => {
    render(ContributeViews, {
      ...base,
      hub: [
        hub({ remoteId: 'a', score: 2 }),
        hub({ remoteId: 'b', installId: '22222222-2222-4222-8222-222222222222', summary: 'Dark theme for every page', score: 3, language: 'en' }),
        hub({ remoteId: 'c', kind: 'bug', area: 'drive', summary: 'Upload fails for large files', score: 9 }),
        hub({ remoteId: 'd', status: 'shipped', summary: 'Faster sign-in', shippedDay: '2026-11-13' }),
      ],
    })
    await expect.element(page.getByTestId('contribute-board')).toBeInTheDocument()
    await page.getByRole('tab', { name: 'All installs' }).click()
    expect(page.getByTestId('contribute-board').elements()).toHaveLength(0)

    const groups = page.getByTestId('hub-group')
    expect(groups.elements()).toHaveLength(3)
    await expect.element(groups.nth(0)).toHaveTextContent('Bug · Drive')
    await expect.element(groups.nth(0)).toHaveTextContent('1 install · score 9')
    await expect.element(groups.nth(1)).toHaveTextContent('Idea · the whole app')
    await expect.element(groups.nth(1)).toHaveTextContent('2 installs · score 5')
    await expect.element(page.getByTestId('hub-status-shipped')).toHaveTextContent('Shipped')
    await expect.element(page.getByText('Dark theme for every page')).toBeInTheDocument()
    await expect.element(page.getByText('Add a dark mode to the whole app')).toHaveAttribute('lang', 'en')
    expect(page.getByRole('button', { name: 'Vote up' }).elements()).toHaveLength(0)
    expect(page.getByText('Ana Lind').elements()).toHaveLength(0)

    await page.getByRole('tab', { name: 'This company' }).click()
    await expect.element(page.getByTestId('contribute-board')).toBeInTheDocument()
  })

  it('an empty central board says so', async () => {
    render(ContributeViews, { ...base, hub: [] })
    await page.getByRole('tab', { name: 'All installs' }).click()
    await expect.element(page.getByText('No install has shared a proposal yet.')).toBeInTheDocument()
  })
})
