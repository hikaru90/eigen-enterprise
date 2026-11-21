import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissProject } from './project-list'

// Re-sealing keys to visibility (shared-memory-keys.ts) is covered by memory-sharing.integration.spec.ts.
const { reconcileThoughtKeysMock, reconcileProjectKeysMock } = vi.hoisted(() => ({
  reconcileThoughtKeysMock: vi.fn(async () => 0),
  reconcileProjectKeysMock: vi.fn(async () => 0),
}))
vi.mock('$lib/server/memory/shared-memory-keys', () => ({
  reconcileThoughtKeys: reconcileThoughtKeysMock,
  reconcileProjectKeys: reconcileProjectKeysMock,
}))

const { getDbMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
}))

vi.mock('$lib/server/db', () => ({
  getDb: getDbMock,
}))
// An ordinary project (the system-project guard has its own integration spec).
vi.mock('$lib/server/memory/system-projects', () => ({
  assertNotSystemProject: vi.fn(async () => undefined),
}))

describe('dismissProject', () => {
  beforeEach(() => vi.clearAllMocks())

  it('removes thought-entity links and sets projectStatus to dismissed', async () => {
    const deleteReturningMock = vi.fn(async () => [{ thoughtId: 't1' }, { thoughtId: 't2' }])
    const deleteWhereMock = vi.fn(() => ({ returning: deleteReturningMock }))
    const deleteMock = vi.fn(() => ({ where: deleteWhereMock }))

    const updateWhereMock = vi.fn(async () => undefined)
    const updateSetMock = vi.fn(() => ({ where: updateWhereMock }))
    const updateMock = vi.fn(() => ({ set: updateSetMock }))

    getDbMock.mockReturnValue({ delete: deleteMock, update: updateMock })

    await dismissProject('user-1', 'entity-1')

    // 1) thoughtEntity rows for this entity should be deleted
    expect(deleteMock).toHaveBeenCalled()
    expect(deleteWhereMock).toHaveBeenCalled()

    // 2) canonicalEntity should be set to dismissed with nextActionThoughtId cleared
    expect(updateMock).toHaveBeenCalled()
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectStatus: 'dismissed',
        nextActionThoughtId: null,
        updatedAt: expect.any(Date),
      }),
    )
    expect(updateWhereMock).toHaveBeenCalled()

    // 3) its tasks are no longer shared through it: their keys go back to the owner's
    expect(reconcileThoughtKeysMock).toHaveBeenCalledWith('user-1', ['t1', 't2'])
  })
})
