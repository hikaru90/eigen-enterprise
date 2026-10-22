import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getDbMock, generateApiKeyMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  generateApiKeyMock: vi.fn(),
}))
vi.mock('$lib/server/db', () => ({ getDb: getDbMock }))
vi.mock('$lib/server/api-keys/api-key-utils', () => ({ generateApiKey: generateApiKeyMock }))

import { dbAppMailKeys, MAIL_KEY_ENV } from './mail-keys'

describe('dbAppMailKeys', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    generateApiKeyMock.mockReturnValue({ raw: 'eigen_raw', prefix: 'eigen_ra...', hash: 'h' })
  })

  it('names the env an app reads', () => {
    expect(MAIL_KEY_ENV).toBe('EE_API_KEY')
  })

  it('mints a key that can send mail and nothing else (MCP off); the raw key is returned once', async () => {
    const returning = vi.fn(async () => [{ id: 'k1' }])
    const values = vi.fn(() => ({ returning }))
    getDbMock.mockReturnValue({ insert: vi.fn(() => ({ values })) })

    const out = await dbAppMailKeys().mint({ userId: 'u1', name: 'app:shop' })
    expect(values).toHaveBeenCalledWith({
      userId: 'u1',
      name: 'app:shop',
      keyPrefix: 'eigen_ra...',
      keyHash: 'h',
      mailSend: true,
      mcp: false,
    })
    expect(out).toEqual({ id: 'k1', raw: 'eigen_raw' })
  })

  it('revoke deactivates the key', async () => {
    const where = vi.fn(async () => undefined)
    const set = vi.fn(() => ({ where }))
    getDbMock.mockReturnValue({ update: vi.fn(() => ({ set })) })

    await dbAppMailKeys().revoke('k1')
    expect(set).toHaveBeenCalledWith({ isActive: false })
    expect(where).toHaveBeenCalledTimes(1)
  })
})
