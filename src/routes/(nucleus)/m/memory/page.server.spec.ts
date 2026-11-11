import { describe, expect, it, vi } from 'vitest'

const { activationsGet, listEvents } = vi.hoisted(() => ({
  listEvents: vi.fn(async (_q: unknown) => ({
    items: [
      {
        id: 'task:t1',
        itemType: 'task',
        semanticSummary: 'Ship invoice',
        projectEntityId: 'p1',
        projectLabel: 'Billing',
      },
      {
        id: 'ev1',
        itemType: 'event',
        semanticSummary: 'Dentist',
        projectEntityId: null,
        projectLabel: null,
      },
      {
        id: 'task:t2',
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
vi.mock('$lib/server/memory/temporal-event-list', () => ({
  listTemporalEventsForUser: listEvents,
  isTaskListItem: (item: { itemType: string }) => item.itemType === 'task',
}))

const { load: layoutLoad } = await import('./+layout.server')
const { load } = await import('./+page.server')

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
      { id: 'task:t1', summary: 'Ship invoice', project: { entityId: 'p1', label: 'Billing' } },
      { id: 'task:t2', summary: 'Call mum', project: null },
    ])
  })
})
