import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePickerIndex } from '../../../../../../modules/brand/taxonomy/load-index'
import fixture from '../../../../../../modules/brand/taxonomy/test-fixtures/picker-fixture.json'

const { getUserRoleMock, executeMock } = vi.hoisted(() => ({ getUserRoleMock: vi.fn(), executeMock: vi.fn() }))

vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: getUserRoleMock }))
vi.mock('$lib/server/brand/picker', () => ({ pickerTree: () => parsePickerIndex(fixture, 'fixture') }))
vi.mock('../../handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../handler')>()),
  executeBrandTool: executeMock,
}))

const { POST } = await import('./+server')

const req = (body: unknown) =>
  ({
    locals: { user: { id: 'u1' } },
    request: new Request('http://x/api/brand/picker/choose', { method: 'POST', body: JSON.stringify(body) }),
  }) as never

async function status(p: Promise<unknown>): Promise<number> {
  try {
    const res = await p
    return (res as Response).status
  } catch (err) {
    return (err as { status: number }).status
  }
}

describe('POST /api/brand/picker/choose', () => {
  beforeEach(() => {
    getUserRoleMock.mockReset()
    executeMock.mockReset()
  })

  it('the owner chooses a final style → runs brand.picker_choose as a human owner', async () => {
    getUserRoleMock.mockResolvedValue('owner')
    executeMock.mockResolvedValue(new Response('{"status":"active"}'))
    const res = (await POST(req({ nodeId: 'swiss-grid-blue' }))) as Response
    expect(res.status).toBe(200)
    expect(executeMock).toHaveBeenCalledWith('brand.picker_choose', { nodeId: 'swiss-grid-blue' }, { id: 'u1' }, [
      'owner',
      'admin',
    ])
  })

  it('refuses admins and members with 403 (fail closed) — nothing runs', async () => {
    for (const role of ['admin', 'member', null]) {
      getUserRoleMock.mockResolvedValue(role)
      expect(await status(POST(req({ nodeId: 'swiss-grid-blue' })))).toBe(403)
    }
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('redirects a signed-out visitor to /login', async () => {
    const event = { locals: { user: null }, request: new Request('http://x', { method: 'POST', body: '{}' }) } as never
    expect(await status(POST(event))).toBe(302)
  })

  it('404 for an unknown node, 400 for a non-final node or a bad body', async () => {
    getUserRoleMock.mockResolvedValue('owner')
    expect(await status(POST(req({ nodeId: 'ghost' })))).toBe(404)
    expect(await status(POST(req({ nodeId: 'swiss-grid' })))).toBe(400)
    expect(await status(POST(req({})))).toBe(400)
    expect(executeMock).not.toHaveBeenCalled()
  })
})
