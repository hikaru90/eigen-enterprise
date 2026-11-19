import { beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from './+server'

const { signOutMock, state } = vi.hoisted(() => ({ signOutMock: vi.fn(), state: { passkeys: 0, mail: false } }))
vi.mock('$lib/server/auth', () => ({ auth: { api: { signOut: signOutMock } } }))
vi.mock('$lib/server/db/auth-db', () => ({
  authDb: { select: () => ({ from: () => ({ where: async () => [{ n: state.passkeys }] }) }) },
}))
vi.mock('$app/environment', () => ({ dev: false }))
vi.mock('$lib/server/mail', () => ({ companyMail: () => ({ isConfigured: async () => state.mail }) }))

const post = (body?: unknown, user: unknown = { id: 'u1' }) =>
  POST({
    locals: { user },
    request: new Request('http://localhost/api/session/sign-out', { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) }),
  } as never)

beforeEach(() => {
  signOutMock.mockClear()
  state.passkeys = 0
  state.mail = false
})

describe('POST /api/session/sign-out', () => {
  it('signs out when there is a way back in (a passkey)', async () => {
    state.passkeys = 1
    const res = await post()
    expect(await res.json()).toEqual({ ok: true })
    expect(signOutMock).toHaveBeenCalledOnce()
  })

  it('signs out when there is a way back in (company email sends codes)', async () => {
    state.mail = true
    expect((await post()).status).toBe(200)
    expect(signOutMock).toHaveBeenCalledOnce()
  })

  it('no passkey and no email: asks first instead of locking the person out', async () => {
    const res = await post()
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'would_lock_out', message: expect.stringMatching(/Add a passkey first/) })
    expect(signOutMock).not.toHaveBeenCalled()
  })

  it('"Sign out anyway" goes through', async () => {
    expect((await post({ confirmLockout: true })).status).toBe(200)
    expect(signOutMock).toHaveBeenCalledOnce()
  })
})
