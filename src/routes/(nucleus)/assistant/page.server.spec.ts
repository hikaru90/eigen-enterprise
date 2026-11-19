import { beforeEach, describe, expect, it, vi } from 'vitest'

const { roleMock, listMock, decisionsMock } = vi.hoisted(() => ({
  roleMock: vi.fn(),
  listMock: vi.fn(),
  decisionsMock: vi.fn(),
}))
vi.mock('$lib/server/auth/user-role', () => ({
  MEMBER_ROLES: ['owner', 'admin', 'member'],
  getUserRole: roleMock,
}))
vi.mock('$lib/server/agent-runs/source', () => ({
  agentRunsSource: () => ({ list: listMock, watch: vi.fn() }),
}))
vi.mock('$lib/server/memory/known-decisions', () => ({ countKnownDecisions: decisionsMock }))

import { load as listLoad } from './+page.server'
import { load as detailLoad } from './[id]/+page.server'

const run = {
  id: 3,
  conversationKey: 'orchestrator:s',
  agentId: 'orchestrator',
  createdAt: '2026-10-30T10:00:00.000Z',
  updatedAt: '2026-10-30T10:00:00.000Z',
}
const ev = (user: { id: string } | null, id = '3') =>
  ({ locals: { user }, params: { id } }) as never

describe('/assistant (conversations) loads', () => {
  beforeEach(() => vi.clearAllMocks())

  it('redirects signed-out visitors to /login', async () => {
    await expect(listLoad(ev(null))).rejects.toMatchObject({ status: 302, location: '/login' })
    await expect(detailLoad(ev(null))).rejects.toMatchObject({ status: 302, location: '/login' })
  })

  it('refuses non-members with 403', async () => {
    roleMock.mockResolvedValue(null)
    await expect(listLoad(ev({ id: 'x' }))).rejects.toMatchObject({ status: 403 })
    expect(listMock).not.toHaveBeenCalled()
    expect(decisionsMock).not.toHaveBeenCalled()
  })

  it('lists runs and resolves one run; unknown ids are 404', async () => {
    roleMock.mockResolvedValue('member')
    listMock.mockResolvedValue([run])
    decisionsMock.mockResolvedValue(1200)
    expect(await listLoad(ev({ id: 'u' }))).toEqual({ runs: [run], knownDecisions: 1200 })
    // "Your Brain knows N decisions": the signed-in member's own Memory, never anyone else's.
    expect(decisionsMock).toHaveBeenCalledWith('u')
    expect(await detailLoad(ev({ id: 'u' }))).toEqual({ run })
    // `renamable` is computed from the signed-in member's side.
    expect(listMock).toHaveBeenCalledWith('u')
    await expect(detailLoad(ev({ id: 'u' }, '9'))).rejects.toMatchObject({ status: 404 })
    await expect(detailLoad(ev({ id: 'u' }, 'x'))).rejects.toMatchObject({ status: 400 })
  })
})
