import { describe, expect, it, vi } from 'vitest'
import { GET, POST } from './+server'

const { listProjectsForUserMock, createUserDeclaredProjectMock } = vi.hoisted(() => ({
  listProjectsForUserMock: vi.fn(),
  createUserDeclaredProjectMock: vi.fn(),
}))

vi.mock('$lib/server/memory/project-list', () => ({
  listProjectsForUser: listProjectsForUserMock,
}))

vi.mock('$lib/server/memory/create-user-project', () => ({
  createUserDeclaredProject: createUserDeclaredProjectMock,
}))

function getEvent(overrides: { user?: { id: string } | null; search?: string } = {}) {
  return {
    locals: { user: overrides.user === undefined ? { id: 'u1' } : overrides.user },
    url: new URL(`http://localhost/api/timeline/projects${overrides.search ?? ''}`),
  } as Parameters<typeof GET>[0]
}

function postEvent(overrides: { user?: { id: string } | null; body?: unknown } = {}) {
  return {
    locals: { user: overrides.user === undefined ? { id: 'u1' } : overrides.user },
    request: new Request('http://localhost/api/timeline/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(overrides.body ?? {}),
    }),
  } as Parameters<typeof POST>[0]
}

describe('GET /api/timeline/projects', () => {
  it('returns 401 when unauthenticated', async () => {
    expect((await GET(getEvent({ user: null }))).status).toBe(401)
  })

  it('defaults author scope to user', async () => {
    listProjectsForUserMock.mockResolvedValue([{ entityId: 'ent-1', label: 'Eigen' }])
    const res = await GET(getEvent())
    expect(listProjectsForUserMock).toHaveBeenCalledWith('u1', { authorScope: 'user' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ projects: [{ entityId: 'ent-1', label: 'Eigen' }] })
  })

  it('passes author=all through to authorScope', async () => {
    listProjectsForUserMock.mockResolvedValue([])
    await GET(getEvent({ search: '?author=all' }))
    expect(listProjectsForUserMock).toHaveBeenCalledWith('u1', { authorScope: 'all' })
  })
})

describe('POST /api/timeline/projects', () => {
  it('returns 401 when unauthenticated', async () => {
    expect((await POST(postEvent({ user: null }))).status).toBe(401)
  })

  it('returns 400 for invalid JSON body', async () => {
    expect(
      (
        await POST({
          locals: { user: { id: 'u1' } },
          request: new Request('http://localhost', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: 'not-json',
          }),
        } as Parameters<typeof POST>[0])
      ).status,
    ).toBe(400)
  })

  it('returns 400 when label is missing', async () => {
    expect((await POST(postEvent({ body: {} }))).status).toBe(400)
  })

  it('creates a user-declared project', async () => {
    createUserDeclaredProjectMock.mockResolvedValue({
      entityId: 'ent-1',
      label: 'New Project',
      status: 'active',
    })
    const res = await POST(postEvent({ body: { label: 'New Project' } }))
    expect(createUserDeclaredProjectMock).toHaveBeenCalledWith({
      userId: 'u1',
      label: 'New Project',
      visibility: 'company',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ entityId: 'ent-1', label: 'New Project', status: 'active' })
  })

  it('passes valid status through', async () => {
    createUserDeclaredProjectMock.mockResolvedValue({
      entityId: 'ent-1',
      label: 'New Project',
      status: 'someday',
    })
    await POST(postEvent({ body: { label: 'New Project', status: 'someday' } }))
    expect(createUserDeclaredProjectMock).toHaveBeenCalledWith({
      userId: 'u1',
      label: 'New Project',
      status: 'someday',
      visibility: 'company',
    })
  })

  it('creates a Private project when asked', async () => {
    createUserDeclaredProjectMock.mockResolvedValue({
      entityId: 'ent-2',
      label: 'Job search',
      status: 'active',
      visibility: 'private',
    })
    await POST(postEvent({ body: { label: 'Job search', private: true } }))
    expect(createUserDeclaredProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'private' }),
    )
    expect((await POST(postEvent({ body: { label: 'x', private: 'yes' } }))).status).toBe(400)
  })

  it('returns 400 when service rejects', async () => {
    createUserDeclaredProjectMock.mockRejectedValue(new Error('boom'))
    const res = await POST(postEvent({ body: { label: 'x' } }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: 'boom',
      agent: { attempted: 'Creating a project from the timeline', cause: 'boom' },
    })
  })
})
