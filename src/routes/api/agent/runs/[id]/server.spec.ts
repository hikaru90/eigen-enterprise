import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RUN_TITLE_MAX } from '$lib/agent-runs/rename'

const { roleMock, renameMock } = vi.hoisted(() => ({ roleMock: vi.fn(), renameMock: vi.fn() }))

vi.mock('$lib/server/auth/user-role', () => ({
  MEMBER_ROLES: ['owner', 'admin', 'member'],
  getUserRole: roleMock,
}))
vi.mock('$lib/server/agent-runs/source', () => ({
  agentRunsSource: () => ({ list: vi.fn(), watch: vi.fn(), rename: renameMock }),
}))

import { PATCH } from './+server'

type Ev = Parameters<typeof PATCH>[0]
const patch = (user: { id: string } | null, body: unknown, id = '7') =>
  PATCH({
    locals: { user },
    params: { id },
    request: new Request('http://x/api/agent/runs/' + id, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  } as unknown as Ev)

const renamed = {
  id: 7,
  conversationKey: 'orchestrator:s-1',
  agentId: 'orchestrator',
  title: 'Bakery website',
  renamable: true,
  createdAt: '2026-10-30T10:00:00.000Z',
  updatedAt: '2026-10-30T10:05:00.000Z',
}

describe('PATCH /api/agent/runs/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    roleMock.mockResolvedValue('member')
  })

  it('refuses anonymous callers with 401', async () => {
    const res = await patch(null, { title: 'x' })
    expect(res.status).toBe(401)
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('refuses non-members with 403 (fail closed)', async () => {
    roleMock.mockResolvedValue(null)
    const res = await patch({ id: 'ghost' }, { title: 'x' })
    expect(res.status).toBe(403)
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects a malformed run id', async () => {
    const res = await patch({ id: 'u1' }, { title: 'x' }, 'abc')
    expect(res.status).toBe(400)
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects an empty (after trim), too long, missing or non-JSON title', async () => {
    for (const body of [
      { title: '   ' },
      { title: 'x'.repeat(RUN_TITLE_MAX + 1) },
      {},
      { title: 3 },
      'not json',
    ]) {
      const res = await patch({ id: 'u1' }, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('renames as the signed-in member with the trimmed title', async () => {
    renameMock.mockResolvedValue({ ok: true, run: renamed })
    const res = await patch({ id: 'u1' }, { title: '  Bakery website  ' })
    expect(res.status).toBe(200)
    expect(renameMock).toHaveBeenCalledWith('u1', 7, 'Bakery website')
    expect(await res.json()).toEqual({ run: renamed })
  })

  it('passes the owner check through: another member gets 403, unknown runs 404', async () => {
    renameMock.mockResolvedValueOnce({ ok: false, status: 403, error: 'Only the member…' })
    expect((await patch({ id: 'u2' }, { title: 'mine now' })).status).toBe(403)
    renameMock.mockResolvedValueOnce({ ok: false, status: 404, error: 'unknown run 7' })
    expect((await patch({ id: 'u2' }, { title: 'x' })).status).toBe(404)
  })
})
