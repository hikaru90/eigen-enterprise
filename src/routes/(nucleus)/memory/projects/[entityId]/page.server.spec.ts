import { describe, expect, it, vi } from 'vitest'
import { load } from './+page.server'

const { loadProjectDetail } = vi.hoisted(() => ({ loadProjectDetail: vi.fn() }))
vi.mock('$lib/server/memory/project-detail', () => ({ loadProjectDetail }))
vi.mock('$lib/server/memory/user-timezone', () => ({
  getUserPreferredTimezone: vi.fn(async () => 'UTC'),
}))

const event = (entityId: string) =>
  ({
    locals: { user: { id: 'u1' } },
    params: { entityId },
    url: new URL(`http://localhost/memory/projects/${entityId}`),
    depends: vi.fn(),
  }) as unknown as Parameters<typeof load>[0]

describe('/memory/projects/[entityId]', () => {
  it('404s for an id that cannot be a project (not a uuid) — never a 500 from the database', async () => {
    await expect(load(event('x'))).rejects.toMatchObject({ status: 404 })
    expect(loadProjectDetail).not.toHaveBeenCalled()
  })

  it('404s for a well-formed id with no project', async () => {
    loadProjectDetail.mockResolvedValueOnce(null)
    await expect(
      load(event('7f1c2a9e-3b4d-4c5e-8f6a-1b2c3d4e5f60')),
    ).rejects.toMatchObject({ status: 404 })
  })
})
