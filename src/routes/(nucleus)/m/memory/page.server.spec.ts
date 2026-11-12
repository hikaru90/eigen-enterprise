import { describe, expect, it, vi } from 'vitest'

const { activationsGet, listEvents } = vi.hoisted(() => ({
  listEvents: vi.fn(async (_q: unknown) => ({
    items: [
      {
        id: 'task:t1',
        thoughtId: 't1',
        itemType: 'task',
        semanticSummary: 'Ship invoice',
        projectEntityId: 'p1',
        projectLabel: 'Billing',
      },
      {
        id: 'ev1',
        thoughtId: 't9',
        itemType: 'event',
        semanticSummary: 'Dentist',
        projectEntityId: null,
        projectLabel: null,
      },
      {
        id: 'task:t2',
        thoughtId: 't2',
        itemType: 'task',
        semanticSummary: 'Call mum',
        projectEntityId: null,
        projectLabel: null,
      },
    ],
    nextCursor: null,
  })),
  activationsGet: vi.fn(async (_id: string) => true),
}))

vi.mock('$lib/server/boot', () => ({
  appKernel: async () => ({
    modules: {
      get: (id: string) =>
        id === 'memory' ? { id: 'memory', name: 'Memory', description: 'Notes and tasks.' } : null,
    },
    activations: { get: activationsGet },
  }),
}))
const deleteThought = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/memory/delete-thought', () => ({ deleteThoughtForUser: deleteThought }))

const privateEnv = vi.hoisted(() => ({ POSTHOG_API_KEY: '' as string | undefined }))
vi.mock('$lib/server/env/private-env', () => ({ env: privateEnv }))

vi.mock('$lib/server/memory/temporal-event-list', () => ({
  listTemporalEventsForUser: listEvents,
  isTaskListItem: (item: { itemType: string }) => item.itemType === 'task',
}))

const { load: layoutLoad } = await import('./+layout.server')
const { load, actions } = await import('./+page.server')

const signedIn = { locals: { user: { id: 'u1' } } }

describe('/m/memory layout', () => {
  it('redirects signed-out visitors to login', async () => {
    await expect(layoutLoad({ locals: { user: null } } as never)).rejects.toMatchObject({
      status: 302,
      location: '/login',
    })
  })

  it('reports the truthful activation state (Memory is a system module: active)', async () => {
    const data = (await layoutLoad(signedIn as never)) as { memory: { active: boolean } }
    expect(activationsGet).toHaveBeenCalledWith('memory')
    expect(data.memory).toEqual({ name: 'Memory', description: 'Notes and tasks.', active: true })
  })

  it('tells the privacy note whether AI requests also go to product analytics (POSTHOG_API_KEY)', async () => {
    privateEnv.POSTHOG_API_KEY = ''
    const off = (await layoutLoad(signedIn as never)) as { privacy: { analyticsSeesAi: boolean } }
    expect(off.privacy).toEqual({ analyticsSeesAi: false })
    privateEnv.POSTHOG_API_KEY = 'phc_test'
    const on = (await layoutLoad(signedIn as never)) as { privacy: { analyticsSeesAi: boolean } }
    expect(on.privacy).toEqual({ analyticsSeesAi: true })
  })
})

describe('/m/memory page (the task list)', () => {
  it('loads open tasks with their project as a tag, dropping calendar events', async () => {
    const data = (await load(signedIn as never)) as {
      tasks: { id: string; summary: string; project: { entityId: string; label: string } | null }[]
    }
    expect(listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', status: 'open', includeTasks: true }),
    )
    expect(data.tasks).toEqual([
      {
        id: 'task:t1',
        thoughtId: 't1',
        summary: 'Ship invoice',
        project: { entityId: 'p1', label: 'Billing' },
      },
      { id: 'task:t2', thoughtId: 't2', summary: 'Call mum', project: null },
    ])
  })
})

describe('/m/memory ?/deleteTask', () => {
  const post = (user: { id: string } | null, thoughtId: string | null) => {
    const body = new FormData()
    if (thoughtId !== null) body.set('thoughtId', thoughtId)
    return actions.deleteTask({
      locals: { user },
      request: new Request('http://x/m/memory?/deleteTask', { method: 'POST', body }),
    } as never)
  }

  it('needs a signed-in person and a task', async () => {
    expect(await post(null, 't1')).toMatchObject({ status: 401 })
    expect(await post({ id: 'u1' }, '')).toMatchObject({ status: 400 })
    expect(deleteThought).not.toHaveBeenCalled()
  })

  it('deletes the task’s thought for good, as the signed-in person', async () => {
    deleteThought.mockResolvedValueOnce({ ok: true })
    expect(await post({ id: 'u1' }, 't1')).toEqual({ deleted: true })
    expect(deleteThought).toHaveBeenCalledWith('u1', 't1')
  })

  it('reports a task that is not theirs as not found, and a Roadmap task as the board’s', async () => {
    deleteThought.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    expect(await post({ id: 'u1' }, 'tX')).toMatchObject({ status: 404 })
    deleteThought.mockResolvedValueOnce({
      ok: false,
      reason: 'system_project_task',
      projectLabel: 'Roadmap',
    })
    expect(await post({ id: 'u1' }, 'tR')).toMatchObject({
      status: 409,
      data: { message: expect.stringContaining('Roadmap') },
    })
  })
})
