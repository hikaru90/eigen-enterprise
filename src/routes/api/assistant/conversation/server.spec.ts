import { beforeEach, describe, expect, it, vi } from 'vitest'

const { roleMock, providerReadyMock, loadConversationMock, loadApprovalStatusesMock } = vi.hoisted(
  () => ({
    roleMock: vi.fn(async (): Promise<string | null> => 'owner'),
    providerReadyMock: vi.fn(async () => true),
    loadConversationMock: vi.fn(async () => ({
      sessionId: null as string | null,
      messages: [] as unknown[],
    })),
    loadApprovalStatusesMock: vi.fn(async () => ({})),
  }),
)

vi.mock('$lib/server/db', () => ({ getDb: () => ({}) }))
vi.mock('$lib/server/auth/user-role', () => ({
  getUserRole: roleMock,
  isAdminRole: (r: string | null) => r === 'owner' || r === 'admin',
}))
vi.mock('$lib/server/llm/provider-ready', () => ({ isCompanyProviderReady: providerReadyMock }))
vi.mock('$lib/server/chat/current-conversation', () => ({
  loadCurrentConversation: loadConversationMock,
  loadApprovalStatuses: loadApprovalStatusesMock,
  loadPendingApprovalsByTool: async () => ({}),
}))

import { GET } from './+server'

/** Stand-in for event.fetch against GET /api/approvals/mode. */
function modeFetch(res: { ok: boolean; body?: unknown }) {
  return vi.fn(async () => ({ ok: res.ok, status: res.ok ? 200 : 404, json: async () => res.body }))
}

async function call(
  user: { id: string } | null,
  fetch = modeFetch({ ok: true, body: { mode: 'ask' } }),
) {
  const res = (await GET({ locals: { user }, fetch } as never)) as Response
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, fetch }
}

describe('GET /api/assistant/conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    roleMock.mockResolvedValue('owner')
    providerReadyMock.mockResolvedValue(true)
    loadConversationMock.mockResolvedValue({ sessionId: null, messages: [] })
  })

  it('refuses anonymous callers', async () => {
    const { status } = await call(null)
    expect(status).toBe(401)
    expect(loadConversationMock).not.toHaveBeenCalled()
  })

  it('restores the saved conversation so the chat survives navigation and reloads', async () => {
    loadConversationMock.mockResolvedValue({
      sessionId: 's-1',
      messages: [
        { role: 'assistant', content: 'Welcome — your website next?', metadata: null },
        { role: 'user', content: 'yes', metadata: null },
      ],
    })
    const { status, body } = await call({ id: 'u1' })
    expect(status).toBe(200)
    expect(loadConversationMock).toHaveBeenCalledWith(expect.anything(), 'u1')
    expect(body).toMatchObject({
      sessionId: 's-1',
      turns: [
        { role: 'assistant', content: 'Welcome — your website next?' },
        { role: 'user', content: 'yes' },
      ],
      providerReady: true,
    })
  })

  it('starts empty when the member has no saved conversation', async () => {
    const { body } = await call({ id: 'u1' })
    expect(body).toMatchObject({ sessionId: null, turns: [] })
  })

  it('says when no AI provider works, so the panel can point at the setup', async () => {
    providerReadyMock.mockResolvedValue(false)
    expect((await call({ id: 'u1' })).body).toMatchObject({ providerReady: false })
  })

  it('restores approval cards with their current kernel status', async () => {
    loadConversationMock.mockResolvedValue({
      sessionId: 's-1',
      messages: [
        {
          role: 'assistant',
          content: '',
          metadata: {
            variant: 'approval_required',
            tool: 'website.publish_page',
            approvalId: 'apr-1',
          },
        },
      ],
    })
    loadApprovalStatusesMock.mockResolvedValueOnce({ 'apr-1': 'pending' })
    const { body } = await call({ id: 'u1' })
    expect(loadApprovalStatusesMock).toHaveBeenCalledWith(expect.anything(), ['apr-1'])
    expect(body).toMatchObject({
      turns: [
        { role: 'approval', tool: 'website.publish_page', approvalId: 'apr-1', status: 'pending' },
      ],
    })
  })

  it('loads the approval mode for the owner/admin only', async () => {
    const owner = await call({ id: 'u1' }, modeFetch({ ok: true, body: { mode: 'reasonable' } }))
    expect(owner.fetch).toHaveBeenCalledWith('/api/approvals/mode')
    expect(owner.body).toMatchObject({
      isAdmin: true,
      approvalMode: { status: 'ok', mode: 'reasonable' },
    })

    roleMock.mockResolvedValue('member')
    const member = await call({ id: 'u2' })
    expect(member.fetch).not.toHaveBeenCalled()
    expect(member.body).toMatchObject({ isAdmin: false, approvalMode: null })
  })

  it('says so when the approval mode cannot be loaded — never a silent default', async () => {
    for (const fetch of [
      modeFetch({ ok: false }),
      modeFetch({ ok: true, body: { mode: 'yolo' } }),
    ]) {
      expect((await call({ id: 'u1' }, fetch)).body).toMatchObject({
        approvalMode: { status: 'unavailable' },
      })
    }
  })
})
