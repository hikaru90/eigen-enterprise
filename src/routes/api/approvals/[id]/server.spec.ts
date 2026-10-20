import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requireAdminMock, decideMock, bootAppMock } = vi.hoisted(() => ({
  requireAdminMock: vi.fn(),
  decideMock: vi.fn(),
  bootAppMock: vi.fn(),
}))

vi.mock('$lib/server/auth/require-admin', () => ({ requireAdmin: requireAdminMock }))
vi.mock('$lib/server/boot', () => ({ bootApp: bootAppMock }))
vi.mock('$lib/server/approvals/owner-decision', () => ({ decideApprovalAsOwner: decideMock }))

const { POST } = await import('./+server')

const registry = { execute: vi.fn() }
const owner = { id: 'owner-1' }

function call(body: unknown, id = 'apr-1') {
  return POST({
    locals: { user: owner },
    params: { id },
    request: {
      json: async () => {
        if (body === 'not-json') throw new SyntaxError('bad')
        return body
      },
    },
  } as never)
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    const res = await p
    return (res as Response).status
  } catch (e) {
    return (e as { status: number }).status
  }
}

describe('POST /api/approvals/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireAdminMock.mockResolvedValue(owner)
    bootAppMock.mockResolvedValue({ kernel: { registry } })
  })

  it('is owner/admin only: a non-admin never reaches the kernel', async () => {
    requireAdminMock.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }))
    expect(await status(call({ decision: 'approved' }))).toBe(403)
    expect(decideMock).not.toHaveBeenCalled()
  })

  it('validates the body: decision must be approved or denied', async () => {
    expect(await status(call({ decision: 'maybe' }))).toBe(400)
    expect(await status(call({}))).toBe(400)
    expect(await status(call('not-json'))).toBe(400)
    expect(decideMock).not.toHaveBeenCalled()
  })

  it('records the decision through the kernel and returns the decided approval', async () => {
    const approval = { id: 'apr-1', toolName: 'website.publish_page', status: 'approved' }
    decideMock.mockResolvedValueOnce({ kind: 'decided', approval })
    const res = await call({ decision: 'approved' })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual(approval)
    expect(decideMock).toHaveBeenCalledWith(registry, owner, 'apr-1', 'approved')
  })

  it('404 for an unknown request, 409 for one already decided', async () => {
    decideMock.mockResolvedValueOnce({ kind: 'not_found' })
    expect(await status(call({ decision: 'denied' }))).toBe(404)
    decideMock.mockResolvedValueOnce({ kind: 'already_decided', approval: { status: 'denied' } })
    expect(await status(call({ decision: 'approved' }))).toBe(409)
  })
})
