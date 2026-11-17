import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The backup health tick runs on a timer, outside any request: every DB read it makes must open its
 * own context (getDb() throws there by design — production logged "[backup-health] tick failed" every
 * 10 minutes). Company-level reads use companyDb(); the owner's push subscriptions are per-user rows
 * read inside withDbUser(owner).
 */
const { companyDbMock, withDbUserMock, sendPushMock } = vi.hoisted(() => {
  const scope = { user: null as string | null }
  return {
    scope,
    companyDbMock: vi.fn(() => ({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 'evt-1' }] }) }) }),
    })),
    withDbUserMock: vi.fn(async (userId: string, fn: () => Promise<unknown>) => {
      scope.user = userId
      try {
        return await fn()
      } finally {
        scope.user = null
      }
    }),
    sendPushMock: vi.fn(async () => {
      if (!scope.user) throw new Error('getDb() was called outside an active request (missing app DB context)')
      return { sent: 1, errors: [] }
    }),
  }
})

vi.mock('$app/environment', () => ({ building: false }))
vi.mock('$lib/server/db', () => ({ companyDb: companyDbMock, withDbUser: withDbUserMock }))
vi.mock('$lib/server/db/auth-db', () => ({ authDb: {} }))
vi.mock('$lib/server/push/send', () => ({ sendPushToUser: sendPushMock }))
vi.mock('$lib/server/ee/client', () => ({ EeClient: class {}, SubstrateUnavailableError: class extends Error {} }))
vi.mock('$lib/server/boot', () => ({ appKernel: vi.fn() }))

describe('backup health wiring outside a request', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads kernel events through the company-level handle', async () => {
    const { liveBackupHealthDeps } = await import('./live')
    await expect(liveBackupHealthDeps({} as never).hasEvent('evt-1')).resolves.toBe(true)
    expect(companyDbMock).toHaveBeenCalled()
  })

  it("pushes to the owner inside the owner's own DB context", async () => {
    const { liveBackupHealthDeps } = await import('./live')
    await liveBackupHealthDeps({} as never).push('owner-1', { title: 'Backup missed', body: 'x' } as never)
    expect(withDbUserMock).toHaveBeenCalledWith('owner-1', expect.any(Function))
    expect(sendPushMock).toHaveBeenCalledWith('owner-1', expect.anything())
  })
})
