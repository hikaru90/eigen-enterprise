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
vi.mock('$lib/server/owlery/mail', () => ({
  isOwleryMailConfigured: isOwleryMailConfiguredMock,
}))

describe('signup page server', () => {
  it('returns plan from valid query param', () => {
    const url = new URL('http://localhost/signup?plan=self-hosted')
    const data = load({ url, locals: { user: null } } as never)
    expect(data).toMatchObject({ plan: 'self-hosted' })
  })

  it('returns null plan when query param omitted', () => {
    const url = new URL('http://localhost/signup')
    const data = load({ url, locals: { user: null } } as never)
    expect(data).toMatchObject({ plan: null })
  })

  it('rejects invalid plan query param', () => {
    const url = new URL('http://localhost/signup?plan=invalid')
    expect(() => load({ url, locals: { user: null } } as never)).toThrow()
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
