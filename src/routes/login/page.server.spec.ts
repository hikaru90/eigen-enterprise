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
const { unclaimedState } = vi.hoisted(() => ({ unclaimedState: { ee: false, unclaimed: null as string | null, openJoin: false } }))
vi.mock('$lib/server/auth/unclaimed', () => ({
  unclaimedMessage: async () => unclaimedState.unclaimed,
  managedByEe: () => unclaimedState.ee,
}))
vi.mock('$lib/server/members/open-join-db', () => ({ openJoinOn: async () => unclaimedState.openJoin }))
vi.mock('$lib/server/mail', () => ({
  companyMail: () => ({ isConfigured: async () => isOwleryMailConfiguredMock() }),
}))

describe('login page server', () => {
  it('exposes mailConfigured for forgot-password / resend UI', async () => {
    isOwleryMailConfiguredMock.mockReturnValue(true)
    const data = await load({
      locals: { user: null },
      url: new URL('http://localhost/login'),
    } as never)
    expect(data).toMatchObject({ mailConfigured: true })
  })

  it('on a claimed ee server: a normal sign-in with no claim/owner message and no signup link', async () => {
    unclaimedState.ee = true
    unclaimedState.unclaimed = null
    const data = await load({ locals: { user: null }, url: new URL('http://localhost/login') } as never)
    expect(data).toMatchObject({ unclaimed: null, signupOpen: false })
    unclaimedState.ee = false
  })

  it('on a claimed ee server with open join on, it offers Join (to /signup)', async () => {
    unclaimedState.ee = true
    unclaimedState.unclaimed = null
    unclaimedState.openJoin = true
    const data = await load({ locals: { user: null }, url: new URL('http://localhost/login') } as never)
    expect(data).toMatchObject({ signupOpen: false, openJoin: true })
    unclaimedState.ee = false
    unclaimedState.openJoin = false
  })

  it('open join is only offered on a claimed ee server', async () => {
    unclaimedState.openJoin = true
    expect(await load({ locals: { user: null }, url: new URL('http://localhost/login') } as never)).toMatchObject({ openJoin: false, signupOpen: true })
    unclaimedState.ee = true
    unclaimedState.unclaimed = 'This server has not been claimed yet.'
    expect(await load({ locals: { user: null }, url: new URL('http://localhost/login') } as never)).toMatchObject({ openJoin: false })
    unclaimedState.ee = false
    unclaimedState.unclaimed = null
    unclaimedState.openJoin = false
  })

  it('on a claimed ee server with open join off, no Join', async () => {
    unclaimedState.ee = true
    const data = await load({ locals: { user: null }, url: new URL('http://localhost/login') } as never)
    expect(data).toMatchObject({ openJoin: false })
    unclaimedState.ee = false
  })

  it('on an unclaimed ee server the page says so', async () => {
    unclaimedState.ee = true
    unclaimedState.unclaimed = 'This server has not been claimed yet.'
    const data = await load({ locals: { user: null }, url: new URL('http://localhost/login') } as never)
    expect(data).toMatchObject({ unclaimed: 'This server has not been claimed yet.' })
    unclaimedState.ee = false
    unclaimedState.unclaimed = null
  })

  it('passwordless: sendCode (no terms on login), verifyCode signs in', async () => {
    const event = { request: new Request('http://localhost/login', { method: 'POST' }) } as never
    await actions.sendCode(event)
    expect(requestCodeMock).toHaveBeenCalledWith(event, { requireTerms: false })
    await actions.verifyCode(event)
    expect(verifyCodeMock).toHaveBeenCalledWith(event)
    expect(Object.keys(actions).sort()).toEqual(['sendCode', 'verifyCode'])
  })
})
