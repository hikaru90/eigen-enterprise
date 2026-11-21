import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DELETE } from './+server'

const { deleteMock, archiveMock } = vi.hoisted(() => ({
  deleteMock: vi.fn(),
  archiveMock: vi.fn(),
}))

vi.mock('$lib/server/memory/delete-thought', () => ({
  deleteTimelineItemForUser: deleteMock,
}))

vi.mock('$lib/server/memory/temporal-event-service', () => ({
  archiveTemporalEventForUser: archiveMock,
}))

/**
 * DELETE is the trash icon of a Tasks / project row: it deletes the thought behind the row for
 * good — never an archive (Contribute 7fa15491). Archive is its own action
 * (`POST /api/temporal-events/:id/action`).
 */
describe('DELETE /api/temporal-events/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deleteMock.mockResolvedValue({ ok: true })
  })

  it('rejects unauthenticated requests', async () => {
    expect((await DELETE({ locals: { user: null }, params: { id: 'e1' } } as never)).status).toBe(
      401,
    )
  })

  it('rejects missing event id', async () => {
    expect(
      (await DELETE({ locals: { user: { id: 'u1' } }, params: { id: '  ' } } as never)).status,
    ).toBe(400)
  })

  it('deletes the thought behind the row for good, never archives it', async () => {
    const res = await DELETE({
      locals: { user: { id: 'u1' } },
      params: { id: 'task:t1' },
    } as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: true, summary: 'Deleted for good.' })
    expect(deleteMock).toHaveBeenCalledWith('u1', 'task:t1')
    expect(archiveMock).not.toHaveBeenCalled()
  })

  it('maps a row that is not the person’s to 404', async () => {
    deleteMock.mockResolvedValue({ ok: false, reason: 'not_found' })
    expect(
      (await DELETE({ locals: { user: { id: 'u1' } }, params: { id: 'e1' } } as never)).status,
    ).toBe(404)
  })

  it('refuses a task of a company system project with 409', async () => {
    deleteMock.mockResolvedValue({
      ok: false,
      reason: 'system_project_task',
      projectLabel: 'Roadmap',
    })
    const res = await DELETE({
      locals: { user: { id: 'u1' } },
      params: { id: 'task:t1' },
    } as never)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      error: expect.stringMatching(/Roadmap/),
      agent: { attempted: 'Deleting a task for good' },
    })
  })
})
