import { describe, expect, it, vi } from 'vitest'

const loadOwnerLogMock = vi.hoisted(() =>
  vi.fn(async () => ({ log: [{ day: '2026-11-04', entries: [] }], modules: [], module: null })),
)
vi.mock('$lib/server/activity/owner-log', () => ({ loadOwnerLog: loadOwnerLogMock }))

import { GET } from './+server'

const call = (user: { id: string } | null, query = '') =>
  GET({
    locals: { user },
    url: new URL(`http://localhost/api/assistant/activity${query}`),
  } as never) as Promise<Response>

describe('GET /api/assistant/activity', () => {
  it('refuses anonymous callers', async () => {
    const res = await call(null)
    expect(res.status).toBe(401)
    expect(loadOwnerLogMock).not.toHaveBeenCalled()
  })

  it('returns the readable log, bounded, with the module filter passed through', async () => {
    const res = await call({ id: 'u1' }, '?module=website')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      log: [{ day: '2026-11-04', entries: [] }],
      modules: [],
      module: null,
    })
    expect(loadOwnerLogMock).toHaveBeenCalledWith('website', 60)
  })
})
