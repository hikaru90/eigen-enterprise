import { describe, expect, it, vi } from 'vitest'

const saveMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('$lib/server/dashboard/hidden-tiles', () => ({ saveHiddenTiles: saveMock }))

import { PUT } from './+server'

function event(over: { user?: { id: string } | null; apiKeyAuth?: boolean; body?: string } = {}) {
  return {
    locals: { user: over.user === undefined ? { id: 'u1' } : over.user, apiKeyAuth: over.apiKeyAuth },
    request: new Request('http://localhost/api/settings/dashboard-tiles', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: over.body ?? JSON.stringify({ hidden: ['apps'] }),
    }),
  } as unknown as Parameters<typeof PUT>[0]
}

describe('PUT /api/settings/dashboard-tiles', () => {
  it('saves the tiles the signed-in person closed', async () => {
    const res = await PUT(event())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ hidden: ['apps'] })
    expect(saveMock).toHaveBeenCalledWith('u1', ['apps'])
  })

  it('only for a signed-in person, not an API key', async () => {
    expect((await PUT(event({ user: null }))).status).toBe(401)
    expect((await PUT(event({ apiKeyAuth: true }))).status).toBe(401)
  })

  it('refuses a body that is not a list of known tiles', async () => {
    saveMock.mockClear()
    expect((await PUT(event({ body: 'nope' }))).status).toBe(400)
    const res = await PUT(event({ body: JSON.stringify({ hidden: ['weather'] }) }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'unknown dashboard tile "weather"' })
    expect(saveMock).not.toHaveBeenCalled()
  })
})
