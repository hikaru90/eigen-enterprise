import type { TemporalEventListItem } from '../api/temporal-events/+server'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import Detail from './temporal-event-detail.svelte'

// SvelteKit's resolve: route id + params → path (the shared stub returns the route id as is).
vi.mock('$app/paths', () => ({
  resolve: (id: string, params: Record<string, string> = {}) =>
    id.replace(/\/\([^)]+\)/g, '').replace(/\[(\w+)\]/g, (_, name: string) => params[name] ?? `[${name}]`),
}))

function task(overrides: Partial<TemporalEventListItem> = {}): TemporalEventListItem {
  return {
    id: 'task:t1',
    itemType: 'task',
    kind: 'task',
    semanticSummary: 'Ship the invoice',
    sourceTextSpan: null,
    timePrecision: 'day',
    timezone: 'Europe/Berlin',
    isAllDay: true,
    confidence: 1,
    startAt: null,
    endAt: null,
    activePeriod: '',
    graphSyncStatus: 'synced',
    graphSyncError: null,
    lifecycleStatus: 'open',
    snoozedUntil: null,
    recurrenceRule: null,
    durationMinutes: null,
    energyLevel: null,
    priorityQuadrant: null,
    contextTags: [],
    focusRank: null,
    parentEventId: null,
    thoughtId: 't1',
    thoughtText: 'Ship the invoice',
    thoughtCategory: 'task',
    thoughtStatus: 'open',
    projectLabel: 'Billing',
    projectEntityId: 'p1',
    completedAt: null,
    lifecycleUpdatedAt: null,
    createdAt: '2026-11-20T09:00:00.000Z',
    author: 'user',
    authorLabel: null,
    ...overrides,
  }
}

const handlers = { onQuickAction: vi.fn(), onInstruction: vi.fn(), onDelete: vi.fn() }

describe('Tasks drawer (what the Overview tab showed: the project, one click away, and Delete)', () => {
  it('links the task’s project to its page', async () => {
    render(Detail, { item: task(), ...handlers })
    await expect.element(page.getByTestId('temporal-event-project')).toHaveTextContent('Billing')
    await expect.element(page.getByTestId('temporal-event-project')).toHaveAttribute('href', '/m/memory/projects/p1')
    await expect.element(page.getByTestId('temporal-event-delete')).toBeInTheDocument()
  })

  it('shows no project line for a task without one', async () => {
    render(Detail, { item: task({ projectLabel: null, projectEntityId: null }), ...handlers })
    await expect.element(page.getByTestId('temporal-event-delete')).toBeInTheDocument()
    await expect.element(page.getByTestId('temporal-event-project')).not.toBeInTheDocument()
  })
})

describe('Tasks drawer: the source thought is editable (wish 2f296da6)', () => {
  it('edits the source thought in place and hands the new text on, verbatim', async () => {
    const onEditThought = vi.fn()
    render(Detail, { item: task(), ...handlers, onEditThought })
    await page.getByTestId('temporal-event-thought-edit').click()
    const box = page.getByTestId('temporal-event-thought-text')
    await expect.element(box).toHaveValue('Ship the invoice')
    await box.fill('Ship the invoice to Acme on Friday')
    await page.getByTestId('temporal-event-thought-save').click()
    expect(onEditThought).toHaveBeenCalledWith('t1', 'Ship the invoice to Acme on Friday')
    await expect.element(page.getByTestId('temporal-event-thought-text')).not.toBeInTheDocument()
  })

  it('cancel leaves the thought as it was', async () => {
    const onEditThought = vi.fn()
    render(Detail, { item: task(), ...handlers, onEditThought })
    await page.getByTestId('temporal-event-thought-edit').click()
    await page.getByTestId('temporal-event-thought-cancel').click()
    expect(onEditThought).not.toHaveBeenCalled()
    await expect.element(page.getByText('Ship the invoice', { exact: true }).last()).toBeInTheDocument()
  })

  it('offers no Edit where no editor is wired', async () => {
    render(Detail, { item: task(), ...handlers })
    await expect.element(page.getByTestId('temporal-event-thought-edit')).not.toBeInTheDocument()
  })
})
