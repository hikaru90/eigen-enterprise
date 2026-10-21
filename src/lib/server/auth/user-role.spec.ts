import { beforeEach, describe, expect, it, vi } from 'vitest'

const { authDbMock } = vi.hoisted(() => ({ authDbMock: { select: vi.fn() } }))

vi.mock('$lib/server/db/auth-db', () => ({ authDb: authDbMock }))

import { getUserRole, isUserAdmin } from './user-role'

function chainSelect(rows: unknown[]) {
  return { from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => rows) })) })) }
}

describe('user-role', () => {
  beforeEach(() => vi.clearAllMocks())

  it('owner and admin are admins; a member is not', async () => {
    for (const [role, admin] of [['owner', true], ['admin', true], ['member', false]] as const) {
      authDbMock.select.mockReturnValue(chainSelect([{ role }]))
      await expect(isUserAdmin('u1')).resolves.toBe(admin)
    }
  })

  it('getUserRole is null when there is no such user', async () => {
    authDbMock.select.mockReturnValue(chainSelect([]))
    await expect(getUserRole('u1')).resolves.toBeNull()
    authDbMock.select.mockReturnValue(chainSelect([]))
    await expect(isUserAdmin('u1')).resolves.toBe(false)
  })
})
