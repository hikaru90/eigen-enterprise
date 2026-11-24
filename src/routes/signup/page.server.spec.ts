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
const { unclaimedState } = vi.hoisted(() => ({
  unclaimedState: {
    ee: false,
    unclaimed: null as string | null,
    openJoin: false,
    demoGuest: null as { userId: string; email: string; name: string; aiCallsPerIp: number } | null,
  },
}))
vi.mock('$lib/server/auth/unclaimed', () => ({
  unclaimedMessage: async () => unclaimedState.unclaimed,
  managedByEe: () => unclaimedState.ee,
}))
vi.mock('$lib/server/members/open-join-db', () => ({ openJoinOn: async () => unclaimedState.openJoin }))
vi.mock('$lib/server/demo/guest-access-db', () => ({ activeDemoGuest: async () => unclaimedState.demoGuest }))
vi.mock('$lib/server/overview/sources', () => ({ foundingCompanyName: async () => 'Northwind' }))
vi.mock('$lib/server/mail', () => ({
  companyMail: () => ({ isConfigured: async () => isOwleryMailConfiguredMock() }),
}))

const claimed = (openJoin: boolean) => {
  unclaimedState.ee = true
  unclaimedState.unclaimed = null
  unclaimedState.openJoin = openJoin
}
const reset = () => {
  unclaimedState.ee = false
  unclaimedState.openJoin = false
}
const post = () => ({ request: new Request('http://localhost/signup', { method: 'POST' }) }) as never

describe('signup page server', () => {
  it('when login-free demo guest access is active, /signup redirects straight to /login welcome card', async () => {
    unclaimedState.demoGuest = {
      userId: 'u-sophie',
      email: 'sophie.wagner@northwind-studio.example',
      name: 'Sophie Wagner',
      aiCallsPerIp: 2,
    }
    await expect(load({ url: new URL('http://localhost/signup'), locals: { user: null } } as never)).rejects.toMatchObject({
      status: 302,
      location: '/login',
    })
    unclaimedState.demoGuest = null
  })

  it('on a claimed ee server with open join off, /signup sends people to the normal sign-in', async () => {
    claimed(false)
    await expect(load({ url: new URL('http://localhost/signup'), locals: { user: null } } as never)).rejects.toMatchObject({
      status: 302,
      location: '/login',
    })
    reset()
  })

  it('on a claimed ee server with open join off, the actions refuse plainly and send no code', async () => {
    claimed(false)
    requestCodeMock.mockClear()
    verifyCodeMock.mockClear()
    for (const action of [actions.sendCode, actions.verifyCode]) {
      const out = (await action(post())) as { status: number; data: { message: string } }
      expect(out.status).toBe(403)
      expect(out.data.message).toBe('Northwind is not open to join. Ask the owner for an invite.')
    }
    expect(requestCodeMock).not.toHaveBeenCalled()
    expect(verifyCodeMock).not.toHaveBeenCalled()
    reset()
  })

  it('on a claimed ee server with open join on, /signup is the join page (email code only, no social sign-up)', async () => {
    claimed(true)
    const data = await load({ url: new URL('http://localhost/signup'), locals: { user: null } } as never)
    expect(data).toMatchObject({ openJoin: true, companyName: 'Northwind', socialProviders: [], unclaimed: null })
    reset()
  })

  it('with open join on, sendCode lets a new address get a code and verifyCode asks for the name', async () => {
    claimed(true)
    const event = post()
    await actions.sendCode(event)
    expect(requestCodeMock).toHaveBeenCalledWith(event, { requireTerms: true, openJoin: true })
    await actions.verifyCode(event)
    expect(verifyCodeMock).toHaveBeenCalledWith(event, { openJoin: true })
    reset()
  })

  it('outside ee, open signup is unchanged', async () => {
    const data = await load({ url: new URL('http://localhost/signup'), locals: { user: null } } as never)
    expect(data).toMatchObject({ openJoin: false })
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
    const event = post()
    await actions.sendCode(event)
    expect(requestCodeMock).toHaveBeenCalledWith(event, { requireTerms: true })
    await actions.verifyCode(event)
    expect(verifyCodeMock).toHaveBeenCalledWith(event)
    expect(Object.keys(actions).sort()).toEqual(['sendCode', 'verifyCode'])
  })
})
