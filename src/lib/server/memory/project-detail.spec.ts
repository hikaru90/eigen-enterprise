import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadProjectDetail } from './project-detail'

const { loadProjectForReaderMock, listTemporalEventsForUserMock, resolveProjectAccessMock } = vi.hoisted(() => ({
  loadProjectForReaderMock: vi.fn(),
  listTemporalEventsForUserMock: vi.fn(),
  resolveProjectAccessMock: vi.fn(),
}))

vi.mock('./team-projects', () => ({
  loadProjectForReader: loadProjectForReaderMock,
}))

vi.mock('./memory-visibility', () => ({
  resolveProjectAccess: resolveProjectAccessMock,
}))

const own = { entityId: 'p1', ownerId: 'u1', ownerName: 'Ana', visibility: 'company', systemKey: null, editable: true }

vi.mock('./temporal-event-list', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./temporal-event-list')>()
  return {
    ...actual,
    listTemporalEventsForUser: listTemporalEventsForUserMock,
  }
})

describe('loadProjectDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when the project does not exist for the reader (absent or a colleague’s private one)', async () => {
    resolveProjectAccessMock.mockResolvedValue(null)

    expect(await loadProjectDetail('u1', 'missing')).toBeNull()
    expect(loadProjectForReaderMock).not.toHaveBeenCalled()
    expect(listTemporalEventsForUserMock).not.toHaveBeenCalled()
  })

  it('returns null when the entity is not a listed project', async () => {
    resolveProjectAccessMock.mockResolvedValue(own)
    loadProjectForReaderMock.mockResolvedValue(null)

    const result = await loadProjectDetail('u1', 'missing')

    expect(result).toBeNull()
    expect(listTemporalEventsForUserMock).not.toHaveBeenCalled()
  })

  it('returns project catalog plus timeline items for that project only', async () => {
    const project = {
      entityId: 'p1',
      label: 'Launch',
      status: 'active' as const,
      source: 'manual' as const,
      nextAction: {
        thoughtId: 't1',
        summary: 'Draft outline',
        itemId: 'task:t1',
      },
      openTaskCount: 2,
      targetDate: '2026-12-01T00:00:00.000Z',
      tasks: [
        { thoughtId: 't1', summary: 'Draft outline', itemId: 'task:t1', rank: 1 },
        { thoughtId: 't2', summary: 'Review', itemId: 'task:t2', rank: 2 },
      ],
      milestones: [
        {
          id: 'm1',
          label: 'Beta',
          targetDate: '2026-10-01T00:00:00.000Z',
          rank: 1,
          completedAt: null,
          linkedThoughtId: null,
        },
      ],
    }
    resolveProjectAccessMock.mockResolvedValue(own)
    loadProjectForReaderMock.mockResolvedValue({ ...project, owner: { id: 'u1', name: 'Ana' }, editable: true })
    listTemporalEventsForUserMock.mockResolvedValue({
      items: [
        {
          id: 'task:t1',
          thoughtId: 't1',
          projectEntityId: 'p1',
          semanticSummary: 'Draft outline',
          lifecycleStatus: 'open',
          thoughtStatus: 'open',
          startAt: '2026-08-01T00:00:00.000Z',
          endAt: null,
        },
        {
          id: 'task:t2',
          thoughtId: 't2',
          projectEntityId: 'p1',
          semanticSummary: 'Review',
          lifecycleStatus: 'completed',
          thoughtStatus: 'completed',
          startAt: null,
          endAt: null,
        },
        {
          id: 'task:other',
          thoughtId: 't9',
          projectEntityId: 'other',
          semanticSummary: 'Other project task',
          lifecycleStatus: 'open',
          thoughtStatus: 'open',
          startAt: null,
          endAt: null,
        },
      ],
      nextCursor: null,
    })

    const result = await loadProjectDetail('u1', 'p1')

    expect(loadProjectForReaderMock).toHaveBeenCalledWith('u1', 'u1', 'p1')
    expect(listTemporalEventsForUserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        status: 'all',
        includeTasks: true,
        range: 'all',
        limit: expect.any(Number),
      }),
    )
    expect(result).toMatchObject({
      project,
      owner: { id: 'u1', name: 'Ana' },
      editable: true,
      items: [
        expect.objectContaining({ id: 'task:t1', projectEntityId: 'p1' }),
        expect.objectContaining({ id: 'task:t2', projectEntityId: 'p1' }),
      ],
    })
    expect(result?.items).toHaveLength(2)
  })

  it('a colleague’s shared project loads its owner’s items, read-only', async () => {
    resolveProjectAccessMock.mockResolvedValue({ ...own, editable: false })
    loadProjectForReaderMock.mockResolvedValue({ entityId: 'p1', label: 'Launch', owner: { id: 'u1', name: 'Ana' }, editable: false })
    listTemporalEventsForUserMock.mockResolvedValue({
      items: [{ id: 'task:t1', thoughtId: 't1', projectEntityId: 'p1' }],
      nextCursor: null,
    })

    const result = await loadProjectDetail('u2', 'p1')

    expect(loadProjectForReaderMock).toHaveBeenCalledWith('u2', 'u1', 'p1')
    expect(listTemporalEventsForUserMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }))
    expect(result).toMatchObject({ editable: false, owner: { id: 'u1' }, items: [{ id: 'task:t1' }] })
    expect(result?.project).not.toHaveProperty('owner')
  })
})
