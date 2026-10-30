import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeEventStream } from '$lib/server/agent-runs/test-fixtures'

const { roleMock, watchMock } = vi.hoisted(() => ({ roleMock: vi.fn(), watchMock: vi.fn() }))

vi.mock('$lib/server/auth/user-role', () => ({
  MEMBER_ROLES: ['owner', 'admin', 'member'],
  getUserRole: roleMock,
}))
vi.mock('$lib/server/agent-runs/source', () => ({
  agentRunsSource: () => ({ list: vi.fn(), watch: watchMock }),
}))

import { GET } from './+server'

type Ev = Parameters<typeof GET>[0]
function event(user: { id: string } | null, id = '7', signal = new AbortController().signal) {
  return {
    locals: { user },
    params: { id },
    request: new Request(`http://localhost/api/agent/runs/${id}/events`, { signal }),
  } as unknown as Ev
}

async function firstFrame(res: Response): Promise<string> {
  const reader = res.body!.getReader()
  const { value } = await reader.read()
  await reader.cancel()
  return new TextDecoder().decode(value)
}

describe('GET /api/agent/runs/[id]/events', () => {
  beforeEach(() => vi.clearAllMocks())

  it('refuses anonymous callers with 401 and never opens a watcher', async () => {
    const res = await GET(event(null))
    expect(res.status).toBe(401)
    expect(watchMock).not.toHaveBeenCalled()
  })

  it('refuses non-members with 403 and never opens a watcher', async () => {
    roleMock.mockResolvedValue(null)
    const res = await GET(event({ id: 'ghost' }))
    expect(res.status).toBe(403)
    expect(watchMock).not.toHaveBeenCalled()
  })

  it('rejects a malformed run id with 400', async () => {
    roleMock.mockResolvedValue('member')
    const res = await GET(event({ id: 'u1' }, 'abc'))
    expect(res.status).toBe(400)
    expect(watchMock).not.toHaveBeenCalled()
  })

  it('answers 404 for a run the index does not know', async () => {
    roleMock.mockResolvedValue('member')
    watchMock.mockResolvedValue(null)
    const res = await GET(event({ id: 'u1' }, '99'))
    expect(res.status).toBe(404)
    expect(watchMock).toHaveBeenCalledWith(99)
  })

  it('streams the snapshot for a member and stops the watcher on disconnect', async () => {
    roleMock.mockResolvedValue('owner')
    const fake = fakeEventStream()
    watchMock.mockResolvedValue(fake.stream)
    const res = await GET(event({ id: 'u1' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(await firstFrame(res)).toBe('event: snapshot\ndata: {"running":false,"items":[]}\n\n')
    expect(fake.stop).toHaveBeenCalledTimes(1)
  })
})
