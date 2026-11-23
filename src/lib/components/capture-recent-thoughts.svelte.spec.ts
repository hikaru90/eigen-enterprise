import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import type { CaptureRecentThoughtSnippet, CaptureSubmitResult } from '$lib/capture/capture-result-types'
import List from './capture-recent-thoughts.svelte'

function detail(id: string, overrides: Partial<CaptureSubmitResult> = {}): CaptureSubmitResult {
  return {
    id,
    normalizedText: `text ${id}`,
    category: 'idea',
    metadata: {},
    cues: [],
    enrichedAt: null,
    entities: [],
    temporalEvents: [],
    linkedThoughts: [],
    attachedFiles: [],
    enrichmentComplete: true,
    gtdProjectLabel: null,
    gtdIsNextAction: false,
    queueStatus: 'complete',
    queueError: null,
    ...overrides,
  }
}

const thoughts: CaptureRecentThoughtSnippet[] = [
  { id: 't1', normalizedText: 'Pricing is decided: 40 a seat', category: 'decision', createdAt: '2026-11-20T09:00:00.000Z', author: 'user', source: 'agent' },
  { id: 't2', normalizedText: 'Acme prefers calls', category: 'preference', createdAt: '2026-11-19T09:00:00.000Z', author: 'agent', authorLabel: 'Coder', source: 'mcp' },
  { id: 't3', normalizedText: 'Old idea', category: 'idea', createdAt: '2025-03-01T09:00:00.000Z', author: 'user', source: null },
]
const details = {
  t1: detail('t1'),
  t2: detail('t2', { enrichmentComplete: false, queueStatus: 'failed', queueError: 'LLM HTTP 500' }),
  t3: detail('t3', { enrichmentComplete: false, queueStatus: 'pending' }),
}

function renderList(overrides: Record<string, unknown> = {}) {
  const props = {
    thoughts,
    thoughtDetails: details,
    limit: 30,
    onExpand: vi.fn(),
    onCollapse: vi.fn(),
    onDelete: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  }
  render(List, props)
  return props
}

describe('capture-recent-thoughts.svelte (Memory › What the brain knows)', () => {
  it('lists each thought with where it came from, its category and whether it is indexed', async () => {
    renderList()
    const rows = page.getByTestId('brain-knows-row')
    await expect.element(rows.nth(0)).toHaveTextContent(/Pricing is decided/)
    await expect.element(rows.nth(0).getByTestId('brain-knows-source')).toHaveTextContent('Through the assistant')
    await expect.element(rows.nth(0).getByTestId('brain-knows-category')).toHaveTextContent('decision')
    await expect.element(rows.nth(0).getByTestId('brain-knows-status')).toHaveTextContent('Indexed')
    await expect.element(rows.nth(1).getByTestId('brain-knows-source')).toHaveTextContent('From Coder')
    await expect.element(rows.nth(1).getByTestId('brain-knows-status')).toHaveTextContent('Indexing failed')
    await expect.element(rows.nth(2).getByTestId('brain-knows-source')).toHaveTextContent('Source not recorded')
    await expect.element(rows.nth(2).getByTestId('brain-knows-status')).toHaveTextContent('Not indexed yet')
  })

  it('offers Retry only on a failed one, and Delete on every one', async () => {
    const props = renderList()
    const rows = page.getByTestId('brain-knows-row')
    await expect.element(rows.nth(0).getByTestId('brain-knows-retry')).not.toBeInTheDocument()
    await rows.nth(1).getByTestId('brain-knows-retry').click()
    expect(props.onRetry).toHaveBeenCalledWith('t2')
    await rows.nth(2).getByTestId('brain-knows-delete').click()
    expect(props.onDelete).toHaveBeenCalledWith('t3')
  })

  it('is read-only: no input, no edit, no mark-done, no attach', async () => {
    renderList()
    await expect.element(page.getByRole('textbox')).not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Mark done' })).not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Attach note' })).not.toBeInTheDocument()
  })

  it('shows a thought the page is watching index as indexing', async () => {
    renderList({ enrichingThoughtIds: new Set(['t3']) })
    await expect.element(page.getByTestId('brain-knows-row').nth(2).getByTestId('brain-knows-status')).toHaveTextContent('Indexing now')
  })

  it('says when it shows only the newest, and when the brain took nothing in yet', async () => {
    renderList({ limit: 3 })
    await expect.element(page.getByTestId('brain-knows-newest')).toHaveTextContent('Showing the newest 3.')
  })

  it('empty: says the brain has taken nothing in', async () => {
    renderList({ thoughts: [], thoughtDetails: {} })
    await expect.element(page.getByTestId('brain-knows-empty')).toHaveTextContent('The brain hasn’t taken anything in yet.')
  })
})
