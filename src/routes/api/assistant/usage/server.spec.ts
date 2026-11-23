import { beforeEach, describe, expect, it, vi } from 'vitest'

const { roleMock, loadMock } = vi.hoisted(() => ({
  roleMock: vi.fn(async (): Promise<string | null> => 'member'),
  loadMock: vi.fn(async (userId: string) => ({
    usage: {
      role: 'member',
      capUsd: 0.5,
      capApplies: true,
      spentUsd: 0.42,
      remainingUsd: 0.08,
      resetsAt: '2026-11-24T00:00:00.000Z',
      userId,
    },
  })),
}))

vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: roleMock }))
vi.mock('$lib/server/settings/member-ai-cap-page', () => ({ loadMemberAiCap: loadMock }))

import { GET } from './+server'

async function call(user: { id: string } | null) {
  const res = (await GET({ locals: { user } } as never)) as Response
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('GET /api/assistant/usage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    roleMock.mockResolvedValue('member')
  })

  it('refuses anonymous callers and people who are not members', async () => {
    expect((await call(null)).status).toBe(401)
    roleMock.mockResolvedValue(null)
    expect((await call({ id: 'u-x' })).status).toBe(403)
    expect(loadMock).not.toHaveBeenCalled()
  })

  it("answers the signed-in person's own usage today (settings.my_ai_usage as them)", async () => {
    const { status, body } = await call({ id: 'u-mia' })
    expect(status).toBe(200)
    expect(loadMock).toHaveBeenCalledWith('u-mia')
    expect(body).toMatchObject({ capUsd: 0.5, spentUsd: 0.42, remainingUsd: 0.08, userId: 'u-mia' })
  })
})
