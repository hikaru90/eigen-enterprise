import type { TemporalEventListItem } from '../api/temporal-events/+server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import TemporalTimelineTaskRow from './temporal-timeline-task-row.svelte'
import TemporalTodaySegmentTabs from './temporal-today-segment-tabs.svelte'
import TimelineShell from './timeline-shell.svelte'

function makeTask(overrides: Partial<TemporalEventListItem> = {}): TemporalEventListItem {
  return {
    id: 'task:1',
    itemType: 'task',
    kind: 'task',
    semanticSummary: 'Default task',
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
    thoughtText: 'Default task',
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
    projectEntityId: null,
    completedAt: null,
    lifecycleUpdatedAt: null,
    createdAt: '2026-11-19T00:00:00.000Z',
    author: 'user',
    authorLabel: null,
    ...overrides,
  }
}

describe('Memory Tasks UX (Contributions 7f44bcfa & ea945d0b)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('orders Today segment tabs as To do, Overdue, Done', async () => {
    const onSegmentChange = vi.fn()
    render(TemporalTodaySegmentTabs, {
      segment: 'todo',
      tabCounts: { todo: 3, overdue: 2, done: 1 },
      onSegmentChange,
    })

    const tabs = Array.from(document.querySelectorAll('[role="tab"]'))
    expect(tabs).toHaveLength(3)
    expect(tabs.map((el) => el.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      '3 To do',
      '2 Overdue',
      '1 Done',
    ])

    await page.getByRole('tab', { name: /Overdue/ }).click()
    expect(onSegmentChange).toHaveBeenCalledWith('overdue')
  })

  it('separates task inspect/edit button from completion circle on task rows', async () => {
    const item = makeTask({
      id: 'task:ov-1',
      semanticSummary: 'Pay studio invoice',
      thoughtText: 'Pay studio invoice',
      thoughtId: 't-ov-1',
      startAt: '2020-01-10T09:00:00.000Z',
    })
    const onSelect = vi.fn()
    const onQuickAction = vi.fn()

    render(TemporalTimelineTaskRow, {
      item,
      selectedItemId: null,
      showOverdueDuration: true,
      timeZone: 'UTC',
      onSelect,
      onQuickAction,
    })

    const editButton = page.getByRole('button', { name: /^Pay studio invoice/ })
    await expect.element(editButton).toHaveAttribute('title', 'Inspect or edit task')
    await expect.element(page.getByTestId('timeline-task-edit-hint')).toBeInTheDocument()

    await editButton.click()
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(item)
    expect(onQuickAction).not.toHaveBeenCalled()

    await page.getByRole('button', { name: 'Mark done: Pay studio invoice' }).click()
    expect(onQuickAction).toHaveBeenCalledTimes(1)
    expect(onQuickAction).toHaveBeenCalledWith('task:ov-1', 'mark_done')
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('opens detail when clicking task text without marking done, and Undo reopens after marking done', async () => {
    let overdueTask = makeTask({
      id: 'task:overdue-1',
      semanticSummary: 'Submit VAT return',
      thoughtText: 'Submit VAT return',
      thoughtId: 'th-overdue-1',
      startAt: '2020-01-10T09:00:00.000Z',
    })
    const todoTask = makeTask({
      id: 'task:todo-1',
      semanticSummary: 'Draft Q4 memo',
      thoughtText: 'Draft Q4 memo',
      thoughtId: 'th-todo-1',
      startAt: null,
    })

    const actionCalls: Array<{ url: string; action: string }> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/timeline/plan-week') {
        return new Response(JSON.stringify({ suggestions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === '/api/temporal-events/task%3Aoverdue-1/action') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { action: 'mark_done' | 'reopen' }
        actionCalls.push({ url, action: body.action })
        if (body.action === 'mark_done') {
          overdueTask = {
            ...overdueTask,
            lifecycleStatus: 'completed',
            thoughtStatus: 'completed',
            completedAt: '2026-11-24T17:00:00.000Z',
          }
          return new Response(
            JSON.stringify({ item: overdueTask, summary: 'Marked task as done.' }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          )
        }
        overdueTask = {
          ...overdueTask,
          lifecycleStatus: 'open',
          thoughtStatus: 'open',
          completedAt: null,
        }
        return new Response(JSON.stringify({ item: overdueTask, summary: 'Reopened task.' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.startsWith('/api/timeline?')) {
        return new Response(JSON.stringify({ items: [overdueTask, todoTask], projects: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(TimelineShell, {
      mode: 'tasks',
      initialSegment: 'overdue',
      prefetchedAuthorScope: 'user',
      userTimeZone: 'UTC',
      prefetchedSource: {
        items: [overdueTask, todoTask],
        projects: [],
      },
    })

    const tabs = Array.from(document.querySelectorAll('[role="tab"]'))
    expect(tabs.map((el) => el.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      '1 To do',
      '1 Overdue',
      '0 Done',
    ])

    await page.getByRole('button', { name: /^Submit VAT return/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Submit VAT return' })
    await expect.element(dialog).toBeInTheDocument()
    await expect.element(dialog).toHaveTextContent('Submit VAT return')
    expect(actionCalls).toEqual([])

    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect.element(dialog).not.toBeInTheDocument()

    await page.getByRole('button', { name: 'Mark done: Submit VAT return' }).click()
    expect(actionCalls).toEqual([
      { url: '/api/temporal-events/task%3Aoverdue-1/action', action: 'mark_done' },
    ])
    await expect.element(page.getByTestId('timeline-quick-action-toast')).toHaveTextContent(
      'Marked task as done.',
    )
    await expect.element(page.getByTestId('timeline-undo')).toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: 'Mark done: Submit VAT return' }))
      .not.toBeInTheDocument()

    await page.getByTestId('timeline-undo').click()
    expect(actionCalls).toEqual([
      { url: '/api/temporal-events/task%3Aoverdue-1/action', action: 'mark_done' },
      { url: '/api/temporal-events/task%3Aoverdue-1/action', action: 'reopen' },
    ])
    await expect
      .element(page.getByRole('button', { name: 'Mark done: Submit VAT return' }))
      .toBeInTheDocument()
    await expect.element(page.getByTestId('timeline-quick-action-toast')).toHaveTextContent(
      'Reopened task.',
    )

    await page.getByTestId('timeline-toast-dismiss').click()
    await expect.element(page.getByTestId('timeline-quick-action-toast')).not.toBeInTheDocument()
  })
})
