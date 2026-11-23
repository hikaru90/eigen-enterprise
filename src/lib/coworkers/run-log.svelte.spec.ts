import type { RunItem } from './run-format'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import RunLog from './run-log.svelte'

/**
 * A co-worker's run log on its profile (plan/phase-ai-coworkers.md C6): the
 * trigger, status with its stop reason, cost and time of each run, a link to
 * the thread or the task, and where the reader may not look, a plain note.
 */

const base: RunItem = {
  id: 'a',
  triggerKind: 'rhythm',
  status: 'done',
  stopReason: null,
  costUsd: 0.0123,
  threadUrl: '/messages?c=c1&t=p1',
  taskUrl: null,
  hidden: false,
  triggeredAt: '2026-11-23T08:00:00.000Z',
  endedAt: '2026-11-23T08:00:09.000Z',
}

describe('RunLog', () => {
  it('lists each run with trigger, status and stop reason, cost, and its link — or why there is none', async () => {
    render(RunLog, {
      runs: [
        base,
        { ...base, id: 'b', triggerKind: 'assignment', threadUrl: null, taskUrl: '/m/memory/tasks#assigned-t1', costUsd: 1.5 },
        { ...base, id: 'c', triggerKind: 'dm', status: 'stopped', stopReason: 'daily_cap', threadUrl: null, hidden: true, costUsd: 0 },
        { ...base, id: 'd', triggerKind: 'assignment', status: 'stopped', stopReason: 'unavailable', threadUrl: null, hidden: true },
      ],
    })
    const rows = page.getByTestId('run')
    await expect.element(rows.nth(0)).toHaveTextContent(/Rhythm · Done.*\$0\.012.*Open thread/)
    await expect.element(rows.nth(0).getByTestId('run-link')).toHaveAttribute('href', '/messages?c=c1&t=p1')
    await expect.element(rows.nth(1)).toHaveTextContent(/Assigned task · Done.*\$1\.50.*Open task/)
    await expect.element(rows.nth(1).getByTestId('run-link')).toHaveAttribute('href', '/m/memory/tasks#assigned-t1')
    await expect.element(rows.nth(2)).toHaveTextContent(/Direct message · Stopped: daily cap reached.*In a conversation you're not in/)
    await expect.element(rows.nth(3).getByTestId('run-hidden')).toHaveTextContent("On a task that isn't yours")
  })

  it('says when it has not worked on anything yet', async () => {
    render(RunLog, { runs: [] })
    await expect.element(page.getByTestId('run-log-empty')).toBeInTheDocument()
  })
})
