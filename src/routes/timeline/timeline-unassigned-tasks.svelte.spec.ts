import type { TemporalEventListItem } from '../api/temporal-events/+server'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import UnassignedTasks from './timeline-unassigned-tasks.svelte'

const task = (id: string, summary: string): TemporalEventListItem =>
  ({
    id,
    itemType: 'task',
    kind: 'task',
    semanticSummary: summary,
    startAt: null,
    endAt: null,
    thoughtStatus: 'open',
    lifecycleStatus: 'open',
    projectLabel: null,
    createdAt: '2026-11-19T00:00:00.000Z',
    author: 'user',
    authorLabel: null,
  }) as TemporalEventListItem

describe('Memory › Projects: the "No project" group (Contribute d5e61e1f)', () => {
  it('is a labelled section with a heading, a one-line hint, and per-task complete + assign', async () => {
    const onQuickAction = vi.fn()
    const onAssign = vi.fn()
    const onGoToTask = vi.fn()
    const tasks = [task('task:1', 'Order the flyers'), task('task:2', 'Call the printer')]
    render(UnassignedTasks, { tasks, onQuickAction, onAssign, onGoToTask })

    const section = page.getByRole('region', { name: /No project/ })
    await expect.element(section).toBeInTheDocument()
    await expect
      .element(page.getByRole('heading', { name: 'No project (2)' }))
      .toBeInTheDocument()
    await expect
      .element(page.getByTestId('unassigned-tasks-hint'))
      .toHaveTextContent(/not in a project yet/i)

    // The heading is a heading, never a control.
    await expect.element(page.getByRole('checkbox')).not.toBeInTheDocument()

    await page.getByRole('button', { name: 'Mark done: Call the printer' }).click()
    expect(onQuickAction).toHaveBeenCalledWith('task:2', 'mark_done')

    await page.getByRole('button', { name: 'Assign' }).first().click()
    expect(onAssign).toHaveBeenCalledWith(tasks[0])

    await page.getByRole('button', { name: /^Order the flyers/ }).click()
    expect(onGoToTask).toHaveBeenCalledWith('task:1')
  })
})
