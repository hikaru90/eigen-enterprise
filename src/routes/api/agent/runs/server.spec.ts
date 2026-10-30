import { beforeEach, describe, expect, it, vi } from 'vitest'

const { roleMock, listMock, watchMock } = vi.hoisted(() => ({
  roleMock: vi.fn(),
  listMock: vi.fn(),
  watchMock: vi.fn(),
}))

vi.mock('$lib/server/auth/user-role', () => ({
  MEMBER_ROLES: ['owner', 'admin', 'member'],
  getUserRole: roleMock,
}))
vi.mock('$lib/server/agent-runs/source', () => ({
  agentRunsSource: () => ({ list: listMock, watch: watchMock }),
}))

import { GET } from './+server'

type Ev = Parameters<typeof GET>[0]
const event = (user: { id: string } | null) => ({ locals: { user } }) as unknown as Ev

const row = {
  id: 7,
  conversationKey: 'orchestrator:s-1',
  agentId: 'orchestrator',
  createdAt: '2026-10-30T10:00:00.000Z',
  updatedAt: '2026-10-30T10:05:00.000Z',
}

describe('GET /api/agent/runs', () => {
  beforeEach(() => vi.clearAllMocks())

  it('refuses anonymous callers with 401 and never touches the index', async () => {
    const res = await GET(event(null))
    expect(res.status).toBe(401)
    expect(listMock).not.toHaveBeenCalled()
  })

  it('refuses a session whose user is not a company member (fail closed)', async () => {
    roleMock.mockResolvedValue(null)
    const res = await GET(event({ id: 'ghost' }))
    expect(res.status).toBe(403)
    expect(listMock).not.toHaveBeenCalled()
  })

  it('lists runs for any member, metadata only', async () => {
    roleMock.mockResolvedValue('member')
    listMock.mockResolvedValue([row])
    const res = await GET(event({ id: 'u1' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ runs: [row] })
  })
})
