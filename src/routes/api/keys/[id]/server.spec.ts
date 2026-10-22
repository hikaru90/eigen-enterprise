import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isApiErrorBody } from '$lib/server/http/api-error'

const { getDbMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
}))

vi.mock('$lib/server/db', () => ({
  getDb: getDbMock,
}))

import { DELETE, PATCH } from './+server'

function deleteEvent(overrides: { user?: { id: string } | null; id?: string } = {}) {
  return {
    locals: { user: overrides.user === undefined ? { id: 'u1' } : overrides.user },
    params: { id: overrides.id ?? 'key-1' },
  } as Parameters<typeof DELETE>[0]
}

function selectLimit(rows: unknown[]) {
  const limit = vi.fn(async () => rows)
  const where = vi.fn(() => ({ limit }))
  const from = vi.fn(() => ({ where }))
  return { from, where, limit }
}

function updateChain() {
  const where = vi.fn(async () => undefined)
  const set = vi.fn(() => ({ where }))
  return { set, where }
}

describe('DELETE /api/keys/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await DELETE(deleteEvent({ user: null }))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(isApiErrorBody(body)).toBe(true)
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 404 when key is missing for the user', async () => {
    const select = vi.fn(() => selectLimit([]))
    getDbMock.mockReturnValue({ select, update: vi.fn() })

    const res = await DELETE(deleteEvent({ id: 'missing' }))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(isApiErrorBody(body)).toBe(true)
    expect(body.error).toBe('Not found')
  })

  it('soft-deletes the key by setting isActive false', async () => {
    const select = vi.fn(() => selectLimit([{ id: 'key-1' }]))
    const update = updateChain()
    getDbMock.mockReturnValue({ select, update: vi.fn(() => update) })

    const res = await DELETE(deleteEvent({ id: 'key-1' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(update.set).toHaveBeenCalledWith({ isActive: false })
    expect(update.where).toHaveBeenCalledTimes(1)
  })
})

function patchEvent(body: unknown, locals: Record<string, unknown> = { user: { id: 'u1' } }) {
  return {
    locals,
    params: { id: 'key-1' },
    request: new Request('http://localhost/api/keys/key-1', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof PATCH>[0]
}

describe('PATCH /api/keys/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when unauthenticated', async () => {
    expect((await PATCH(patchEvent({ mailSend: true }, { user: null }))).status).toBe(401)
  })

  it('an API-key caller may not change scopes', async () => {
    const res = await PATCH(
      patchEvent({ mailSend: true }, { user: { id: 'u1' }, apiKeyAuth: { id: 'k', name: 'n' } }),
    )
    expect(res.status).toBe(403)
    expect(getDbMock).not.toHaveBeenCalled()
  })

  it('rejects a body that is not { mailSend?, mcp? } with booleans only', async () => {
    expect((await PATCH(patchEvent({ mailSend: 1 }))).status).toBe(400)
    expect((await PATCH(patchEvent({ mailSend: true, extra: 1 }))).status).toBe(400)
    expect((await PATCH(patchEvent({}))).status).toBe(400)
    expect((await PATCH(patchEvent({ mcp: 'yes' }))).status).toBe(400)
    expect((await PATCH(patchEvent(null))).status).toBe(400)
    expect(getDbMock).not.toHaveBeenCalled()
  })

  it('returns 404 for a key the user does not own', async () => {
    getDbMock.mockReturnValue({ select: vi.fn(() => selectLimit([])), update: vi.fn() })
    expect((await PATCH(patchEvent({ mailSend: true }))).status).toBe(404)
  })

  it('sets mailSend', async () => {
    const update = updateChain()
    getDbMock.mockReturnValue({
      select: vi.fn(() => selectLimit([{ id: 'key-1' }])),
      update: vi.fn(() => update),
    })
    const res = await PATCH(patchEvent({ mailSend: true }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'key-1', mailSend: true })
    expect(update.set).toHaveBeenCalledWith({ mailSend: true })
  })

  it('turns MCP off for a key', async () => {
    const update = updateChain()
    getDbMock.mockReturnValue({
      select: vi.fn(() => selectLimit([{ id: 'key-1' }])),
      update: vi.fn(() => update),
    })
    const res = await PATCH(patchEvent({ mcp: false }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'key-1', mcp: false })
    expect(update.set).toHaveBeenCalledWith({ mcp: false })
  })

  it('sets both scopes in one call', async () => {
    const update = updateChain()
    getDbMock.mockReturnValue({
      select: vi.fn(() => selectLimit([{ id: 'key-1' }])),
      update: vi.fn(() => update),
    })
    const res = await PATCH(patchEvent({ mailSend: true, mcp: false }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'key-1', mailSend: true, mcp: false })
    expect(update.set).toHaveBeenCalledWith({ mailSend: true, mcp: false })
  })
})
