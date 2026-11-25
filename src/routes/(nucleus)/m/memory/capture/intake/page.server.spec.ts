import { beforeEach, describe, expect, it, vi } from 'vitest'

const { roleMock, executeMock } = vi.hoisted(() => ({
  roleMock: vi.fn(async (): Promise<string | null> => 'member'),
  executeMock: vi.fn(async () => ({
    asOf: 'now',
    totals: { day: 0, week: 0, month: 0, all: 0 },
    bySource: [],
    recent: [],
  })),
}))

vi.mock('$lib/server/auth/user-role', () => ({
  getUserRole: roleMock,
  kernelRolesFor: (role: string) => [role],
}))
vi.mock('$lib/server/boot', () => ({
  appKernel: async () => ({ registry: { execute: executeMock } }),
}))

import { load } from './+page.server'

describe('Memory › What the brain took in: page load', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    roleMock.mockResolvedValue('member')
  })

  it('sends a signed-out visitor to sign in and refuses someone who is no member', async () => {
    await expect(load({ locals: { user: null } } as never)).rejects.toMatchObject({
      status: 302,
      location: '/login',
    })
    roleMock.mockResolvedValue(null)
    await expect(load({ locals: { user: { id: 'x' } } } as never)).rejects.toMatchObject({
      status: 403,
    })
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('runs memory.intake as the signed-in person with their own roles', async () => {
    const result = await load({ locals: { user: { id: 'ony' } } } as never)
    expect(executeMock).toHaveBeenCalledWith(
      'memory.intake',
      { limit: 30 },
      expect.objectContaining({ principal: { id: 'ony', kind: 'human', roles: ['member'] } }),
    )
    expect(result).toMatchObject({ limit: 30, intake: { bySource: [], recent: [] } })
  })
})
