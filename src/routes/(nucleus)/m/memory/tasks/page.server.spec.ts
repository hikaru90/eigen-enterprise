import { describe, expect, it, vi } from 'vitest'
import { memoryAssignedTaskStore } from '$lib/server/memory/assigned-tasks/memory-store'
import type { AssignedTaskDeps } from '$lib/server/memory/assigned-tasks/service'

const { depsHolder } = vi.hoisted(() => ({ depsHolder: { deps: null as unknown } }))

vi.mock('$lib/server/memory/assigned-tasks/live', () => ({
  assignedTaskDeps: async () => depsHolder.deps,
}))
vi.mock('../../../../timeline/timeline-page-load', () => ({
  loadTimelinePageData: async (event: { locals: App.Locals }) => ({
    user: event.locals.user,
    prefetchedTimeline: [],
  }),
}))

import { assignTask } from '$lib/server/memory/assigned-tasks/service'
import { actions, load } from './+page.server'

const people = [
  { id: 'alex', name: 'Alex', email: 'alex@k.co' },
  { id: 'ony', name: 'Ony', email: 'ony@k.co' },
  { id: 'sam', name: 'Sam', email: 'sam@k.co' },
]

function setup() {
  const deps: AssignedTaskDeps = {
    store: memoryAssignedTaskStore(),
    directory: {
      get: async (id) => people.find((p) => p.id === id) ?? null,
      list: async () => people,
    },
    notify: vi.fn(async () => {}),
  }
  depsHolder.deps = deps
  return deps
}

const as = (id: string) => ({ locals: { user: { id, name: id } } as unknown as App.Locals })
const post = (id: string, fields: Record<string, string>) => {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.set(k, v)
  return {
    ...as(id),
    request: new Request('http://x/m/memory/tasks', { method: 'POST', body: form }),
  }
}
type Ev = Parameters<typeof load>[0]
type ActEv = Parameters<(typeof actions)['complete']>[0]

describe('Memory › Tasks page: assigned tasks', () => {
  it('loads the tasks assigned to and by the signed-in member next to their own timeline', async () => {
    const deps = setup()
    await assignTask(
      deps,
      { userId: 'alex', via: 'person' },
      { assigneeId: 'ony', title: 'Book the venue' },
    )
    const data = (await load(as('ony') as unknown as Ev)) as {
      assigned: { assignedToMe: Array<{ title: string }> }
      prefetchedTimeline: unknown
    }
    expect(data.prefetchedTimeline).toEqual([])
    expect(data.assigned.assignedToMe.map((t) => t.title)).toEqual(['Book the venue'])
  })

  it('the assignee completes and comments; the assigner marks it seen; a stranger gets a 404 message', async () => {
    const deps = setup()
    const t = await assignTask(
      deps,
      { userId: 'alex', via: 'person' },
      { assigneeId: 'ony', title: 'Book the venue' },
    )
    expect(
      await actions.comment(
        post('ony', { task_id: t.id, body: 'Booked a shortlist.' }) as unknown as ActEv,
      ),
    ).toEqual({ taskId: t.id, ok: true })
    expect(await actions.complete(post('ony', { task_id: t.id }) as unknown as ActEv)).toEqual({
      taskId: t.id,
      ok: true,
    })
    expect(await actions.seen(post('alex', { task_id: t.id }) as unknown as ActEv)).toEqual({
      taskId: t.id,
      ok: true,
    })
    const refused = (await actions.complete(
      post('sam', { task_id: t.id }) as unknown as ActEv,
    )) as {
      status: number
      data: { error: string; agent: { attempted: string; input: unknown; code: string } }
    }
    expect(refused.status).toBe(404)
    expect(refused.data.error).toMatch(/not found/)
    expect(refused.data.agent).toMatchObject({
      attempted: 'Completing an assigned task on /m/memory/tasks',
      input: { task_id: t.id },
      code: 'AssignedTaskError',
    })
    const twice = (await actions.complete(post('ony', { task_id: t.id }) as unknown as ActEv)) as {
      status: number
    }
    expect(twice.status).toBe(400)
  })
})
