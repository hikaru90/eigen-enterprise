import { describe, expect, it, vi } from 'vitest'
import { POST } from './+server'

const { dismissProjectMock } = vi.hoisted(() => ({
  dismissProjectMock: vi.fn(),
}))

vi.mock('$lib/server/memory/project-list', () => ({
  dismissProject: dismissProjectMock,
}))

function event(overrides: { user?: { id: string } | null; entityId?: string } = {}) {
  return {
    locals: { user: overrides.user === undefined ? { id: 'u1' } : overrides.user },
    params: { entityId: overrides.entityId ?? 'ent-1' },
  } as Parameters<typeof POST>[0]
}

describe('POST /api/timeline/projects/[entityId]/dismiss', () => {
  it('returns 401 when unauthenticated', async () => {
    expect((await POST(event({ user: null }))).status).toBe(401)
  })

  it('returns 400 when entityId is missing', async () => {
    expect((await POST(event({ entityId: ' ' }))).status).toBe(400)
  })

  it('dismisses the project', async () => {
    dismissProjectMock.mockResolvedValue(undefined)
    const res = await POST(event())
    expect(dismissProjectMock).toHaveBeenCalledWith('u1', 'ent-1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, summary: 'Project dismissed.' })
  })

  it('returns 400 when service rejects', async () => {
    dismissProjectMock.mockRejectedValue(new Error('boom'))
    expect((await POST(event())).status).toBe(400)
  })
})
