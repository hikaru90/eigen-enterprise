import { beforeEach, describe, expect, it, vi } from 'vitest'

const { setWelcomeDisplayNameMock } = vi.hoisted(() => ({
  setWelcomeDisplayNameMock: vi.fn(),
}))

vi.mock('$lib/server/onboarding/welcome', () => ({
  setWelcomeDisplayName: setWelcomeDisplayNameMock,
}))

import { POST } from './+server'

function event(user: { id: string } | null, body?: unknown) {
  return {
    locals: { user },
    request: {
      json: () => (body === undefined ? Promise.reject(new Error('no body')) : Promise.resolve(body)),
    },
  } as Parameters<typeof POST>[0]
}

describe('POST /api/onboarding/name', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(event(null, { name: 'Ada' }))
    expect(res.status).toBe(401)
    expect(setWelcomeDisplayNameMock).not.toHaveBeenCalled()
  })

  it('persists the trimmed name for the signed-in user', async () => {
    const res = await POST(event({ id: 'u1' }, { name: '  Ada  ' }))

    expect(setWelcomeDisplayNameMock).toHaveBeenCalledWith('u1', 'Ada')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, name: 'Ada' })
  })

  it('rejects an empty name with 400 — never a fake ok', async () => {
    const res = await POST(event({ id: 'u1' }, { name: '   ' }))

    expect(res.status).toBe(400)
    expect(setWelcomeDisplayNameMock).not.toHaveBeenCalled()
  })

  it('rejects names over 80 characters with 400', async () => {
    const res = await POST(event({ id: 'u1' }, { name: 'x'.repeat(81) }))

    expect(res.status).toBe(400)
    expect(setWelcomeDisplayNameMock).not.toHaveBeenCalled()
  })

  it('rejects a non-JSON body with 400', async () => {
    const res = await POST(event({ id: 'u1' }))

    expect(res.status).toBe(400)
    expect(setWelcomeDisplayNameMock).not.toHaveBeenCalled()
  })

  it('fails loud when persistence breaks', async () => {
    setWelcomeDisplayNameMock.mockRejectedValue(new Error('db down'))

    await expect(POST(event({ id: 'u1' }, { name: 'Ada' }))).rejects.toThrow('db down')
  })
})
