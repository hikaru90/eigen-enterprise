import type { TemporalEventListItem } from '../api/temporal-events/+server'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import StatusButton from './temporal-event-status-button.svelte'

const task = (over: Partial<TemporalEventListItem> = {}): TemporalEventListItem => ({
  id: 'task:1',
  itemType: 'task',
  kind: 'task',
  semanticSummary: 'Order the flyers',
  sourceTextSpan: null,
  timePrecision: 'day',
  timezone: 'UTC',
  isAllDay: true,
  confidence: 1,
  startAt: null,
  endAt: null,
  activePeriod: '',
  graphSyncStatus: 'synced',
  graphSyncError: null,
  thoughtId: 't1',
  thoughtText: 'Order the flyers',
  thoughtCategory: 'task',
  thoughtStatus: 'open',
  lifecycleStatus: 'open',
  snoozedUntil: null,
  recurrenceRule: null,
  durationMinutes: null,
  energyLevel: null,
  priorityQuadrant: null,
  contextTags: [],
  focusRank: null,
  parentEventId: null,
  projectLabel: null,
  completedAt: null,
  lifecycleUpdatedAt: null,
  createdAt: '2026-11-19T00:00:00.000Z',
  author: 'user',
  authorLabel: null,
  ...over,
})

describe('Task row completion control (Contribute d5e61e1f)', () => {
  it('is a round completion button named after the task — not a selection checkbox', async () => {
    const onQuickAction = vi.fn()
    render(StatusButton, { item: task(), compact: true, onQuickAction })

    const button = page.getByRole('button', { name: 'Mark done: Order the flyers' })
    await expect.element(button).toBeInTheDocument()
    await expect.element(page.getByRole('checkbox')).not.toBeInTheDocument()
    await expect.element(button).toHaveAttribute('data-shape', 'round')
    await expect.element(button).toHaveAttribute('title', 'Mark done')

    const circle = button.element().querySelector('span')
    expect(circle).not.toBeNull()
    expect(circle?.className).toMatch(/(^| )text-muted-foreground( |$)/)
    expect(circle?.className).not.toContain('text-transparent')
    expect(circle?.querySelector('svg')).not.toBeNull()

    await button.click()
    expect(onQuickAction).toHaveBeenCalledWith('task:1', 'mark_done')
  })

  it('a done task shows the check and offers to reopen it, by name', async () => {
    const onQuickAction = vi.fn()
    render(StatusButton, {
      item: task({ lifecycleStatus: 'completed', thoughtStatus: 'completed' }),
      compact: true,
      onQuickAction,
    })

    const button = page.getByRole('button', { name: 'Reopen: Order the flyers' })
    await expect.element(button).toHaveAttribute('data-state', 'done')
    await expect.element(button).toHaveAttribute('title', 'Reopen')
    await button.click()
    expect(onQuickAction).toHaveBeenCalledWith('task:1', 'reopen')
  })
})
