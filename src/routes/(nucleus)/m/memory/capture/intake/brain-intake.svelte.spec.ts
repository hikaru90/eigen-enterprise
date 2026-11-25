import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import type { BrainIntake } from '$lib/memory/brain-intake'
import BrainIntakeView from './brain-intake.svelte'

const intake = (over: Partial<BrainIntake> = {}): BrainIntake => ({
  asOf: '2026-11-25T12:00:00.000Z',
  totals: { day: 3, week: 5, month: 8, all: 12 },
  bySource: [
    { source: { kind: 'assistant' }, counts: { day: 2, week: 3, month: 5, all: 7 } },
    {
      source: { kind: 'connected_agent', name: 'Coder' },
      counts: { day: 0, week: 1, month: 1, all: 3 },
    },
    { source: { kind: 'shared_document' }, counts: { day: 1, week: 1, month: 2, all: 2 } },
  ],
  recent: [
    {
      kind: 'document',
      id: 'd2',
      at: '2026-11-25T11:00:00.000Z',
      title: null,
      category: null,
      sharedBy: 'Ben',
      source: { kind: 'shared_document' },
      href: '/m/memory/notes?note=d2',
    },
    {
      kind: 'thought',
      id: 't1',
      at: '2026-11-25T10:00:00.000Z',
      title: 'Acme wants the offer by Friday',
      category: 'task',
      sharedBy: null,
      source: { kind: 'assistant' },
      href: '/m/memory/capture?thought=t1',
    },
  ],
  ...over,
})

describe('Memory › What the brain took in', () => {
  it('shows the totals per period and one row per source with its counts', async () => {
    render(BrainIntakeView, { intake: intake(), limit: 30 })
    await expect.element(page.getByTestId('intake-total-day')).toHaveTextContent('3')
    await expect.element(page.getByTestId('intake-total-day')).toHaveTextContent('24 hours')
    await expect.element(page.getByTestId('intake-total-all')).toHaveTextContent('12')
    const rows = page.getByTestId('intake-source-row').all()
    expect(rows).toHaveLength(3)
    await expect.element(rows[0]!).toHaveTextContent('Through the assistant')
    await expect.element(rows[0]!).toHaveTextContent(/2\s*3\s*5\s*7/)
    await expect.element(rows[1]!).toHaveTextContent('From Coder')
    await expect.element(rows[2]!).toHaveTextContent('Shared by colleagues')
    await expect.element(page.getByTestId('intake-scope')).toHaveTextContent(/theirs alone/)
  })

  it('lists the newest items first, each linked to where it opens, with source and who shared it', async () => {
    render(BrainIntakeView, { intake: intake(), limit: 30 })
    const items = page.getByTestId('intake-item').all()
    expect(items).toHaveLength(2)
    await expect.element(items[0]!).toHaveTextContent('Untitled document')
    await expect.element(items[0]!).toHaveTextContent('Shared by Ben')
    await expect
      .element(items[0]!.getByRole('link'))
      .toHaveAttribute('href', '/m/memory/notes?note=d2')
    await expect.element(items[1]!).toHaveTextContent('Acme wants the offer by Friday')
    await expect.element(items[1]!).toHaveTextContent('Through the assistant')
    await expect.element(items[1]!).toHaveTextContent('task')
    await expect
      .element(items[1]!.getByRole('link'))
      .toHaveAttribute('href', '/m/memory/capture?thought=t1')
  })

  it('says when the list is cut at the limit, and when nothing came in yet', async () => {
    const full = render(BrainIntakeView, { intake: intake(), limit: 2 })
    await expect.element(page.getByTestId('intake-newest')).toHaveTextContent('The newest 2 items')
    full.unmount()
    render(BrainIntakeView, {
      intake: intake({ totals: { day: 0, week: 0, month: 0, all: 0 }, bySource: [], recent: [] }),
      limit: 30,
    })
    await expect
      .element(page.getByTestId('intake-empty'))
      .toHaveTextContent('hasn’t taken anything in yet')
    await expect.element(page.getByTestId('intake-source-row')).not.toBeInTheDocument()
  })
})
