import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isApiErrorBody } from '$lib/server/http/api-error'

const { getDbMock, generateApiKeyMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  generateApiKeyMock: vi.fn(),
}))

vi.mock('$lib/server/db', () => ({
  getDb: getDbMock,
}))

vi.mock('$lib/server/api-keys/api-key-utils', () => ({
  generateApiKey: generateApiKeyMock,
}))

import { GET, POST } from './+server'

function getEvent(user: { id: string } | null) {
  return { locals: { user } } as Parameters<typeof GET>[0]
}

function postEvent(overrides: { user?: { id: string } | null; body?: unknown } = {}) {
  return {
    locals: { user: overrides.user === undefined ? { id: 'u1' } : overrides.user },
    request: new Request('http://localhost/api/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(overrides.body ?? {}),
    }),
  } as Parameters<typeof POST>[0]
}

function selectKeysChain(rows: unknown[]) {
  const orderBy = vi.fn(async () => rows)
  const where = vi.fn(() => ({ orderBy }))
  const from = vi.fn(() => ({ where }))
  return { from }
}

function insertKeyChain(row: { id: string }) {
  const returning = vi.fn(async () => [row])
  const values = vi.fn(() => ({ returning }))
  return { values, returning }
}

describe('GET /api/keys', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await GET(getEvent(null))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(isApiErrorBody(body)).toBe(true)
    expect(body.error).toBe('Unauthorized')
  })

  it('lists active keys for the user', async () => {
    const select = vi.fn(() =>
      selectKeysChain([
        {
          id: 'k1',
          name: 'default',
          keyPrefix: 'eigen_abcd...',
          isActive: true,
          lastUsedAt: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    )
    getDbMock.mockReturnValue({ select })

    const res = await GET(getEvent({ id: 'u1' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.keys).toHaveLength(1)
    expect(body.keys[0]).toMatchObject({ id: 'k1', name: 'default', keyPrefix: 'eigen_abcd...' })
  })
})

describe('POST /api/keys', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    generateApiKeyMock.mockReturnValue({
      raw: 'eigen_raw_secret_key',
      prefix: 'eigen_raw_...',
      hash: 'hash-abc',
    })
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(postEvent({ user: null }))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(isApiErrorBody(body)).toBe(true)
    expect(body.error).toBe('Unauthorized')
  })

  it('creates a key with the provided name', async () => {
    const insertChain = insertKeyChain({ id: 'key-1' })
    const insert = vi.fn(() => insertChain)
    getDbMock.mockReturnValue({ insert })

    const res = await POST(postEvent({ body: { name: '  Laptop  ' } }))
    expect(res.status).toBe(201)
    expect(generateApiKeyMock).toHaveBeenCalledTimes(1)
    expect(insertChain.values).toHaveBeenCalledWith({
      userId: 'u1',
      name: 'Laptop',
      keyPrefix: 'eigen_raw_...',
      keyHash: 'hash-abc',
      mailSend: false,
      mcp: true,
    })
    expect(await res.json()).toEqual({
      key: 'eigen_raw_secret_key',
      prefix: 'eigen_raw_...',
      name: 'Laptop',
      id: 'key-1',
      mailSend: false,
      mcp: true,
    })
  })

  it('defaults name to "default" when missing or blank', async () => {
    const insertChain = insertKeyChain({ id: 'key-2' })
    getDbMock.mockReturnValue({ insert: vi.fn(() => insertChain) })

    const res = await POST(postEvent({ body: { name: '   ' } }))
    expect(res.status).toBe(201)
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'default', userId: 'u1' }),
    )
    expect(await res.json()).toMatchObject({ name: 'default', id: 'key-2' })
  })

  it('defaults name to "default" when JSON body is invalid', async () => {
    const insertChain = insertKeyChain({ id: 'key-3' })
    getDbMock.mockReturnValue({ insert: vi.fn(() => insertChain) })

    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: new Request('http://localhost/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      }),
    } as Parameters<typeof POST>[0])

    expect(res.status).toBe(201)
    expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ name: 'default' }))
  })

  it('creates a key that can send mail when mailSend is true', async () => {
    const insertChain = insertKeyChain({ id: 'key-4' })
    getDbMock.mockReturnValue({ insert: vi.fn(() => insertChain) })
    const res = await POST(postEvent({ body: { name: 'bot', mailSend: true } }))
    expect(res.status).toBe(201)
    expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ mailSend: true }))
    expect(await res.json()).toMatchObject({ mailSend: true })
  })

  it('rejects a non-boolean mailSend', async () => {
    const res = await POST(postEvent({ body: { name: 'bot', mailSend: 'yes' } }))
    expect(res.status).toBe(400)
  })

  it('creates a mail-only key when mcp is false (an app binding never reads the brain)', async () => {
    const insertChain = insertKeyChain({ id: 'key-5' })
    getDbMock.mockReturnValue({ insert: vi.fn(() => insertChain) })
    const res = await POST(postEvent({ body: { name: 'app:site', mailSend: true, mcp: false } }))
    expect(res.status).toBe(201)
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ mailSend: true, mcp: false }),
    )
    expect(await res.json()).toMatchObject({ mailSend: true, mcp: false })
  })

  it('rejects a non-boolean mcp', async () => {
    const res = await POST(postEvent({ body: { name: 'bot', mcp: 'no' } }))
    expect(res.status).toBe(400)
    expect(getDbMock).not.toHaveBeenCalled()
  })

  it('an API-key caller may not mint a mail-sending key (only the owner consents)', async () => {
    const res = await POST({
      ...postEvent({ body: { name: 'bot', mailSend: true } }),
      locals: { user: { id: 'u1' }, apiKeyAuth: { id: 'k', name: 'n' } },
    } as Parameters<typeof POST>[0])
    expect(res.status).toBe(403)
    expect(getDbMock).not.toHaveBeenCalled()
  })
})
