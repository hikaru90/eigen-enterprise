import { describe, expect, it, vi } from 'vitest'
import { actions, load } from './+page.server'

const { requestCodeMock, verifyCodeMock, isOwleryMailConfiguredMock } = vi.hoisted(() => ({
  requestCodeMock: vi.fn(async () => ({ step: 'code', email: 'a@b.co', notice: 'sent' })),
  verifyCodeMock: vi.fn(async () => ({})),
  isOwleryMailConfiguredMock: vi.fn(() => false),
}))
vi.mock('$lib/server/auth/email-code-actions', () => ({
  requestCode: requestCodeMock,
  verifyCode: verifyCodeMock,
}))
const { unclaimedState } = vi.hoisted(() => ({ unclaimedState: { ee: false, unclaimed: null as string | null } }))
vi.mock('$lib/server/auth/unclaimed', () => ({
  unclaimedMessage: async () => unclaimedState.unclaimed,
  managedByEe: () => unclaimedState.ee,
}))
vi.mock('$lib/server/mail', () => ({
  companyMail: () => ({ isConfigured: async () => isOwleryMailConfiguredMock() }),
}))

describe('signup page server', () => {
  it('on a claimed ee server, /signup sends people to the normal sign-in', async () => {
    unclaimedState.ee = true
    await expect(load({ url: new URL('http://localhost/signup'), locals: { user: null } } as never)).rejects.toMatchObject({
      status: 302,
      location: '/login',
    })
    unclaimedState.ee = false
  })

  it('returns plan from valid query param', async () => {
    const url = new URL('http://localhost/signup?plan=self-hosted')
    const data = await load({ url, locals: { user: null } } as never)
    expect(data).toMatchObject({ plan: 'self-hosted' })
  })

  it('returns null plan when query param omitted', async () => {
    const url = new URL('http://localhost/signup')
    const data = await load({ url, locals: { user: null } } as never)
    expect(data).toMatchObject({ plan: null })
  })

  it('rejects invalid plan query param', async () => {
    const url = new URL('http://localhost/signup?plan=invalid')
    await expect(load({ url, locals: { user: null } } as never)).rejects.toThrow()
  })

  it('passwordless: sendCode requires the terms, verifyCode completes signup', async () => {
    const event = { request: new Request('http://localhost/signup', { method: 'POST' }) } as never
    await actions.sendCode(event)
    expect(requestCodeMock).toHaveBeenCalledWith(event, { requireTerms: true })
    await actions.verifyCode(event)
    expect(verifyCodeMock).toHaveBeenCalledWith(event)
    expect(Object.keys(actions).sort()).toEqual(['sendCode', 'verifyCode'])
  })
})
