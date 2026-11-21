import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import type { AssignedTaskView } from '$lib/server/memory/assigned-tasks/service'
import AssignedTasks from './assigned-tasks.svelte'

const task = (over: Partial<AssignedTaskView>): AssignedTaskView => ({
  id: 't1',
  title: 'Send the Q4 deck',
  context: 'The client wants it before the call.',
  dueOn: '2026-11-21',
  status: 'open',
  createdVia: 'assistant',
  createdAt: '2026-11-19T09:00:00.000Z',
  completedAt: null,
  assigner: { id: 'alex', name: 'Alex' },
  assignee: { id: 'ony', name: 'Ony' },
  role: 'assignee',
  update: { kind: 'assigned', at: '2026-11-19T09:00:00.000Z' },
  comments: [],
  ...over,
})

describe('Memory › Tasks: assigned between members', () => {
  it('the assignee sees the task with who assigned it, context and due day, and can mark it done', async () => {
    render(AssignedTasks, { assigned: { assignedToMe: [task({})], assignedByMe: [] } })
    const group = page.getByTestId('assigned-tasks-to-me')
    await expect.element(group).toHaveTextContent(/Assigned to you/)
    await expect.element(page.getByText('Send the Q4 deck', { exact: true })).toBeInTheDocument()
    await expect
      .element(page.getByTestId('assigned-task-meta'))
      .toHaveTextContent('From Alex · via the assistant · due 21 Nov 2026')
    await expect
      .element(page.getByTestId('assigned-task-context'))
      .toHaveTextContent('The client wants it before the call.')
    await expect.element(page.getByTestId('assigned-task-done')).toBeInTheDocument()
    await expect.element(page.getByTestId('assigned-tasks-by-me')).not.toBeInTheDocument()
  })

  it('the assigner sees the completion and the comment as new, with Got it — and no Done of their own', async () => {
    render(AssignedTasks, {
      assigned: {
        assignedToMe: [],
        assignedByMe: [
          task({
            role: 'assigner',
            status: 'done',
            completedAt: '2026-11-19T11:00:00.000Z',
            update: { kind: 'completed', at: '2026-11-19T11:00:00.000Z' },
            comments: [
              {
                id: 'c1',
                author: { id: 'ony', name: 'Ony' },
                body: 'Sent with pricing.',
                at: '2026-11-19T10:00:00.000Z',
              },
            ],
          }),
        ],
      },
      formError: { taskId: 't1', error: "'Send the Q4 deck' is already done.", agent: null },
    })
    await expect
      .element(page.getByTestId('assigned-tasks-by-me'))
      .toHaveTextContent(/Assigned by you/)
    await expect
      .element(page.getByTestId('assigned-task-meta'))
      .toHaveTextContent('To Ony · via the assistant · due 21 Nov 2026 · done')
    await expect
      .element(page.getByTestId('assigned-task-update'))
      .toHaveTextContent("Ony completed 'Send the Q4 deck'")
    await expect
      .element(page.getByTestId('assigned-task-comment'))
      .toHaveTextContent(/Ony.*Sent with pricing\./)
    await expect.element(page.getByTestId('assigned-task-seen')).toBeInTheDocument()
    await expect.element(page.getByTestId('assigned-task-done')).not.toBeInTheDocument()
    await expect.element(page.getByRole('alert')).toHaveTextContent('already done')
    await expect
      .element(page.getByRole('button', { name: 'Copy agent instructions' }))
      .toBeInTheDocument()
  })

  it('forms post to the given page actions; nothing renders without assigned tasks', async () => {
    const screen = render(AssignedTasks, {
      assigned: { assignedToMe: [task({ update: null })], assignedByMe: [] },
      action: '/m/memory/tasks',
    })
    const forms = [...screen.container.querySelectorAll('form')].map((f) =>
      f.getAttribute('action'),
    )
    expect(forms).toEqual(['/m/memory/tasks?/complete', '/m/memory/tasks?/comment'])
    await expect.element(page.getByTestId('assigned-task-seen')).not.toBeInTheDocument()
    screen.unmount()
    render(AssignedTasks, { assigned: { assignedToMe: [], assignedByMe: [] } })
    await expect.element(page.getByTestId('assigned-tasks')).not.toBeInTheDocument()
  })
})
