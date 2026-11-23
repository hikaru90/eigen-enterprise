import { beforeEach, describe, expect, it, vi } from 'vitest'

const { authDbMock } = vi.hoisted(() => ({ authDbMock: { select: vi.fn() } }))

vi.mock('$lib/server/db/auth-db', () => ({ authDb: authDbMock }))

import { getUserRole, isUserAdmin, personFor } from './user-role'

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

describe('personFor — the person the company brain acts as (CB3)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('a member holds member rights only; owner and admins also run the company', async () => {
    for (const [role, roles] of [
      ['member', ['member']],
      ['admin', ['admin', 'member']],
      ['owner', ['admin', 'member']],
    ] as const) {
      authDbMock.select.mockReturnValue(chainSelect([{ role }]))
      await expect(personFor('u1')).resolves.toEqual({ id: 'u1', roles })
    }
  })

  it('an AI co-worker is no person: the brain never acts as one (plan/phase-ai-coworkers.md §3)', async () => {
    authDbMock.select.mockReturnValue(chainSelect([{ role: 'member', kind: 'coworker' }]))
    await expect(personFor('cw_1')).resolves.toBeNull()
    authDbMock.select.mockReturnValue(chainSelect([{ role: 'member', kind: 'human' }]))
    await expect(personFor('ann')).resolves.toEqual({ id: 'ann', roles: ['member'] })
  })

  it('no member, no person: the brain never acts for someone who is not in the company', async () => {
    authDbMock.select.mockReturnValue(chainSelect([]))
    await expect(personFor('stranger')).resolves.toBeNull()
    await expect(personFor('')).resolves.toBeNull()
  })
})
