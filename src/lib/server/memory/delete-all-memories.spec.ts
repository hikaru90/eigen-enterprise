import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DELETE_ALL_MEMORIES_CONFIRMATION } from '$lib/memory/delete-confirmation'
import {
  assertDeleteAllMemoriesConfirmation,
  deleteAllMemoriesForUser,
} from './delete-all-memories'

const { getDbMock, deleteAllUserGraphVerticesMock, moveToTrashMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  deleteAllUserGraphVerticesMock: vi.fn(),
  moveToTrashMock: vi.fn(),
}))

vi.mock('$lib/server/db', () => ({ getDb: getDbMock }))
vi.mock('$lib/server/graph/age', () => ({
  deleteAllUserGraphVertices: deleteAllUserGraphVerticesMock,
}))
// Documents are Drive files: their files go to the Drive trash.
vi.mock('../../../../modules/drive', () => ({
  driveService: async () => ({ moveToTrash: moveToTrashMock }),
}))

describe('deleteAllMemoriesForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deleteAllUserGraphVerticesMock.mockResolvedValue(undefined)
    moveToTrashMock.mockResolvedValue(undefined)
  })

  it('rejects wrong confirmation phrase', () => {
    expect(() => assertDeleteAllMemoriesConfirmation('nope')).toThrow(/exactly match/)
  })

  it('accepts the exact confirmation phrase', () => {
    expect(() =>
      assertDeleteAllMemoriesConfirmation(DELETE_ALL_MEMORIES_CONFIRMATION),
    ).not.toThrow()
  })

  it('deletes postgres rows then wipes graph', async () => {
    // `where` is awaited directly or continued with `.returning()` (notes, deliveries).
    const deleteWhere = vi.fn(() =>
      Object.assign(Promise.resolve(undefined), {
        // The note n1 is a Drive document copied from the old text file n1: one note, not two.
        returning: vi.fn(async () => [{ id: 'n1', copiedFrom: 'n1' }]),
      }),
    )
    const updateWhere = vi.fn().mockResolvedValue(undefined)
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{ id: 't1' }, { id: 't2' }]),
        })),
      })),
      delete: vi.fn(() => ({ where: deleteWhere })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: updateWhere })),
      })),
    }
    getDbMock.mockReturnValue({
      transaction: vi.fn(async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx)),
    })

    const result = await deleteAllMemoriesForUser('u1')

    expect(result).toEqual({ thoughtsDeleted: 2, entitiesDeleted: 2, notesDeleted: 1 })
    expect(deleteWhere).toHaveBeenCalled()
    expect(moveToTrashMock).toHaveBeenCalledWith({ kind: 'user', userId: 'u1' }, 'file', 'n1')
    expect(deleteAllUserGraphVerticesMock).toHaveBeenCalledWith('u1')
  })
})
